# Feature reference

Every feature this bot has, what it does, and how to use it. Companion to [REQUIREMENT.md](./REQUIREMENT.md) (design rationale) and [README.md](./README.md) (setup + deploy).

> All examples assume `@OpenCodeBot` is installed in your workspace and you're talking to it via DM or `@mention`. Slash commands work the same in DMs and channels.

## Table of contents

1. [Core flow: how the bot runs opencode](#core-flow-how-the-bot-runs-opencode)
2. [Streaming output](#streaming-output)
3. [File-upload fallback for long output](#file-upload-fallback-for-long-output)
4. [Free-form DMs and `@mention`s](#free-form-dms-and-mentions)
5. [Slash commands](#slash-commands)
   - [Run opencode against a repo](#run-opencode-against-a-repo) — `review`, `qa`, `ship`, `explore`, `plan`, `bg`
   - [Thread / session management](#thread--session-management) — `continue`, `model`, `agent`, `cost`, `reset`
   - [Other](#other) — `schedule`, `bookmarks`, `help`
6. [Reactions](#reactions)
7. [Background jobs](#background-jobs)
8. [Scheduled tasks](#scheduled-tasks)
9. [Bookmarks](#bookmarks)
10. [Daily cost digest](#daily-cost-digest)
11. [Sessions and threads](#sessions-and-threads)
12. [Cost tracking + per-thread cap](#cost-tracking--per-thread-cap)
13. [Authorization](#authorization)
14. [Repo allowlist](#repo-allowlist)
15. [Audit log](#audit-log)
16. [Persistence and backups](#persistence-and-backups)
17. [CLI / npm scripts](#cli--npm-scripts)

---

## Core flow: how the bot runs opencode

For every prompt the bot:

1. Posts an initial `🕐 _Thinking..._` message in Slack.
2. Spawns `opencode run --format json` as a child process in the configured repo (`cwd`).
3. Reads opencode's line-delimited JSON event stream from stdout.
4. Edits the Slack message every ~1 second with the latest accumulated state (rate-limited to one `chat.update` per channel per second to stay under Slack limits).
5. On completion, swaps `🕐` → `✅` and appends a `tokens · cost · elapsed` footer.
6. On error, swaps `🕐` → `❌` with the failure reason (last 500 chars of opencode's stderr).
7. On cancellation (❌ reaction), swaps to `🛑 Cancelled.` with whatever partial output had streamed so far.

Tool calls inside opencode show up live with an icon (`🔧 bash`, `📖 read`, `✏️ edit`, `🔍 glob/grep`, `🌐 fetch`, `📝 todowrite`) and the tool's own description, e.g. `🔧 _Lists files in current directory_`.

## Streaming output

The streaming message renders in this order of precedence:

1. `❌ <error>` if opencode errored
2. `🛑 Cancelled.\n\n<partial>` if the user cancelled
3. `✅ <text>\n\n_<tokens> · $<cost> · <elapsed>s_` once `step_finish` arrives and the run exits cleanly
4. `🕐 <accumulated text>` while streaming text
5. `<icon> _<tool description>_` while a tool is running and no text has streamed yet
6. `🕐 _Thinking..._` at the very start

Standard markdown in opencode's output is auto-converted to Slack mrkdwn before posting:
- `**bold**` → `*bold*`
- `# Heading` → `*Heading*`
- `[text](url)` → `<url|text>`
- Code fences and inline backticks pass through unchanged

## File-upload fallback for long output

If the final response would exceed **35 Slack blocks OR 8000 characters**, the bot:

1. Replaces the streaming message with `✅ Output too long for inline — uploaded as <command>-<timestamp>.md (N chars)` plus the cost footer.
2. Uploads the full text via `files.uploadV2` as a `.md` file in the same thread.

Filename format: `<command>-2025-11-04T22-13-20.md`. If upload fails (rare), the bot falls back to a truncated inline reply rather than losing the output entirely.

Tunable via the constants `INLINE_BLOCK_LIMIT` and `INLINE_CHAR_LIMIT` in [src/types.ts](src/types.ts) — these are intentionally not env vars (Decisions §15-16).

## Free-form DMs and `@mention`s

DM the bot directly or `@mention` it in a channel where it's been invited. The bot treats the message text as a prompt for the **default agent** (configurable via `DEFAULT_AGENT`, defaults to `general`).

```
You: what's the most-changed file in the last week?
Bot: 🕐 🔍 _Searching git log_
     🕐 ✅ The most-changed file is `src/auth/jwt.ts`...
     ✅ The most-changed file is `src/auth/jwt.ts` with 14 commits...
        _21,508 tokens · $0.0184 · 6.3s_
```

The thread root (the bot's reply) becomes the **session key** for that conversation — subsequent messages in the thread continue the same opencode session.

## Slash commands

All slash commands start with `/oc`. Type `/oc help` in Slack for an interactive Block Kit panel.

### Run opencode against a repo

Each of these spawns opencode and streams the response back.

#### `/oc review <PR-number> [repo]`

Runs the **reviewer** agent on a pull request.

```
/oc review 142
/oc review 142 my-repo          # uses /root/projects/my-repo if it's in ALLOWED_REPOS
```

The bot passes `Review pull request #142.` as the prompt. Repo arg matches by basename against `ALLOWED_REPOS`. (Note: V1 doesn't auto-fetch the diff — opencode's reviewer agent fetches it.)

#### `/oc qa <file-path> [repo]`

Runs the **qa** agent to generate tests for a file.

```
/oc qa src/auth/jwt.ts
/oc qa server/handlers.ts my-repo
```

#### `/oc ship [--plan-only] <task description>`

Runs the **ship** agent (full implement + branch + tests + PR) — or, with `--plan-only`, the **plan** agent (writes a plan, no code or commits).

```
/oc ship bump axios to latest, fix any breakage
/oc ship --plan-only refactor the email-sending code path
```

`--plan-only` is the dry-run mode — useful before letting the bot actually touch code.

#### `/oc explore <question>`

Runs the **explore** agent (read-only codebase exploration).

```
/oc explore where is the auth middleware applied?
/oc explore why are we using a custom JWT lib instead of jsonwebtoken?
```

#### `/oc plan <task>`

Runs the **plan** agent to plan a task without writing code or running commands.

```
/oc plan add OAuth login support for Google + GitHub
```

#### `/oc bg <prompt>`

Queues the prompt as a [background job](#background-jobs) and DMs the result when it's done. Useful for long operations (full repo audits, big refactors).

```
/oc bg do a security review of the entire src/auth/ tree
```

The bot replies immediately: `🟡 Background job #42 queued: ...`. When the job finishes, you'll get a fresh DM with the full streamed response.

### Thread / session management

These read or modify the per-thread session state and only do anything inside a thread.

#### `/oc continue <prompt>`

Resumes your **most recent session** (whichever thread you last interacted with) with a new prompt. The bot looks up your last session's `opencodeSessionId`, agent, model, and repo, and runs the new prompt against them.

```
/oc continue add unit tests for the changes you just made
```

Useful when you've moved channels or threads and want to extend a previous run without scrolling for it.

#### `/oc model [model-id]`

Show or set the model for the current thread.

```
/oc model                                     # → "Current model: _(default)_"
/oc model anthropic/claude-sonnet-4-5         # → "Switched. Applies on your next message."
```

The switch takes effect on the **next** message in the thread (Decisions §13) — the live opencode session keeps its current model.

#### `/oc agent [agent-name]`

Same shape as `/oc model`, but for the agent.

```
/oc agent reviewer
```

#### `/oc cost`

Token / cost summary for the current thread + your daily total + the workspace's monthly total.

```
/oc cost
→ *This thread:* 87,432 tokens · $0.0312
  *You today:* 412,108 tokens · $0.1487
  *Workspace this month:* 8.4M tokens · $3.08
  *Per-session limit:* $1.00
```

#### `/oc reset`

Forgets the current thread's session record. The next message in the thread starts fresh.

```
/oc reset → "✅ Session forgotten for this thread."
```

### Other

#### `/oc schedule <when> <subcommand> [args]`

Runs another `/oc` subcommand on a recurring schedule. See [Scheduled tasks](#scheduled-tasks) for the full syntax.

```
/oc schedule daily 9am explore what changed in the last 24 hours
/oc schedule list
/oc schedule remove 3
```

#### `/oc bookmarks`

Lists messages you've saved with the 📌 reaction. See [Bookmarks](#bookmarks).

```
/oc bookmarks
```

#### `/oc help`

Shows a Block Kit panel listing every command, grouped by purpose, with the cancel-via-❌ and bookmark-via-📌 footer.

## Reactions

Slack reactions on bot messages are a shortcut UI:

| Emoji | Reaction name | What it does |
|---|---|---|
| ❌ | `x` | Cancels the running opencode subprocess for that message. Sends `SIGTERM`, waits 3s, escalates to `SIGKILL`. **No rollback** — files written and commits made are not undone. |
| 📌 | `pushpin` | Bookmarks the message — records its channel, ts, snippet, and Slack permalink so you can retrieve it later via `/oc bookmarks`. |

The cancel handler only fires on bot messages currently being streamed (Decisions §12) — random ❌ reactions on other messages are ignored.

## Background jobs

`/oc bg <prompt>` enqueues a job into the `background_jobs` SQLite table. A worker inside the bot polls the queue every 5 seconds (only one job runs at a time) and handles it like a regular streaming run, but with the result going to a fresh DM with the user.

```
You (in #channel): /oc bg audit src/auth for OWASP top 10 issues
Bot:               🟡 Background job #7 queued: audit src/auth for OWASP top 10 issues. I'll DM you when done.
                   ...
[20 minutes later, in DM]
Bot:               🟡 _Background job #7: audit src/auth for OWASP top 10 issues_
                   🕐 🔍 _Searching for known vulnerability patterns_
                   ...
                   ✅ Found 3 issues, severity high...
                   _114,290 tokens · $0.0432 · 1142.3s_
```

Why this exists: long ops would otherwise clog the inline thread or hit Slack's 3-second slash command ack window awkwardly.

Schema: `background_jobs(id, user_id, initiating_channel, initiating_ts, prompt, agent, repo_path, status, created_at, started_at, completed_at, result_text, exit_code)`.

## Scheduled tasks

`/oc schedule <when> <subcommand>` registers a recurring task. The scheduler ticks every 60 seconds and runs anything whose `next_run_at` has passed, then computes the next fire time.

**Schedule syntax:**

| Form | Example | Meaning |
|---|---|---|
| `hourly` | `hourly cost` | every hour on the minute |
| `daily HH:MM` | `daily 14:30 explore what changed today` | every day at HH:MM **UTC** |
| `daily 9am` | `daily 9am review last 24h commits` | 12-hour clock with `am`/`pm` |
| `weekly DAY HH:MM` | `weekly mon 9am cost` | every week on DAY (mon/tue/.../sun) at HH:MM UTC |

**Subcommands:**

```
/oc schedule daily 9am explore what changed yesterday
   → ✅ Scheduled #1 daily at 09:00 UTC: `explore what changed yesterday`
     Next run: 2026-05-07T09:00Z

/oc schedule list
   → *Your scheduled tasks:*
     • #1 daily at 09:00 UTC — `explore what changed yesterday` (next: 2026-05-07T09:00Z)
     • #2 hourly — `cost` (next: 2026-05-06T19:00Z)

/oc schedule remove 1
   → ✅ Removed scheduled task #1.
```

The fired task replays the dispatcher: it parses `explore what changed yesterday` as if you typed `/oc explore what changed yesterday`, runs it, and posts the result to the **channel where the schedule was created** (the `task.channel` recorded on creation).

Schema: `scheduled_tasks(id, user_id, channel, schedule_kind, schedule_hour, schedule_minute, schedule_weekday, command_text, enabled, last_run_at, next_run_at, created_at)`.

## Bookmarks

React 📌 on **any** bot message and the bot:

1. Looks up the message text via `conversations.history` (best-effort — works in DMs and any channel where the bot has `*:history` scope).
2. Fetches a Slack permalink via `chat.getPermalink`.
3. Stores `(user_id, channel, message_ts, snippet, permalink, created_at)` in the `bookmarks` table.
4. Replies with an ephemeral `📌 Bookmarked.` confirmation.

Then `/oc bookmarks` lists your last 20 bookmarks newest-first, with the snippet and a clickable permalink:

```
*Your last 3 bookmark(s):*
• `2026-05-06 14:32Z` <https://your.slack.com/archives/.../p1700|view> — Found 3 issues, severity high…
• `2026-05-06 12:01Z` <https://your.slack.com/archives/.../p1652|view> — The most-changed file is `src/auth/jwt.ts`…
• `2026-05-05 17:55Z` (no preview)
```

The 📌 → bookmark handler de-duplicates: reacting twice to the same message records only one entry.

## Daily cost digest

A worker checks every minute and, the first time it sees `09:00 UTC` on a new day, DMs each `ALLOWED_USER` their previous day's totals:

```
*Yesterday's opencode usage*
412,108 tokens · $0.1487
_(workspace cap: $1.00 per thread)_
```

Skipped for users who had no activity. Idempotent across restarts via the `meta.last_digest_date_utc` row — the bot won't double-fire even if it restarts at 09:01.

## Sessions and threads

Every Slack thread the bot participates in maps to one **session**. Sessions are keyed by `thread_ts` (or the message ts, if the message has no thread root) and persisted to SQLite, so they survive `systemctl restart`.

A session tracks:
- `user_id` — the originator (used by `/oc cost` and `/oc continue`)
- `repo_path` — which repo opencode runs in for this thread
- `model_override`, `agent_override` — set via `/oc model` / `/oc agent`
- `opencode_session_id` — the opencode-side session ID, captured on the first event so subsequent messages can pass `--session <id>` and continue the same opencode context
- `total_tokens`, `total_cost_usd` — running totals
- `last_active_at`

Sessions older than 30 days are pruned automatically (in-process, no separate cron — Decisions §17).

## Cost tracking + per-thread cap

Token and cost data come from opencode's `step_finish` events (`part.tokens.total`, `part.cost`). They're stored as-is on the session, with no provider-specific math (Decisions §8).

`MAX_COST_PER_SESSION_USD` (default `$1.00`) is checked at the **start of each new run** against the thread's accumulated cost. If a thread is over the cap, the bot refuses to run and tells you to `/oc reset`. A single runaway step can still overshoot — enforcement is post-hoc per Decisions §9.

## Authorization

Allowlist mode only: `ALLOWED_USERS` is a comma-separated list of Slack user IDs. Anything from a user not on the list is logged and dropped — no reply, ephemeral or otherwise.

Reactions also check the allowlist: a non-allowlisted user can't cancel or bookmark anything via reactions.

(V2 will add per-command permissions and workspace mode — see [REQUIREMENT.md](./REQUIREMENT.md).)

## Repo allowlist

`ALLOWED_REPOS` is a comma-separated list of absolute paths. The `[repo]` arg in `/oc review` and `/oc qa` is resolved against this list:

- Exact match: `ALLOWED_REPOS=/root/projects/foo` matches arg `/root/projects/foo`.
- Basename match: `ALLOWED_REPOS=/root/projects/foo` matches arg `foo`.
- Ambiguous (multiple basename matches): error.
- Not in list: error.

`DEFAULT_REPO` is required and **must itself be in `ALLOWED_REPOS`** (validated at startup).

Pre-flight check: before each opencode run, the bot verifies the repo path exists on disk via `existsSync`. If not, it replies `❌ Repo path not found on disk: /path/...` instead of spawning opencode.

## Audit log

Every command (slash, DM, mention, scheduled, background) writes a row to `audit_log`:

```
audit_log(id, ts, user_id, command, repo, exit_code, duration_ms)
```

There's no slash command to view it yet — query SQLite directly:

```bash
sqlite3 /var/lib/opencode-slack-bot/state.db \
  "SELECT datetime(ts/1000,'unixepoch'), user_id, command, exit_code, duration_ms
   FROM audit_log ORDER BY ts DESC LIMIT 20"
```

## Persistence and backups

Everything lives in one SQLite file at `${DATA_DIR}/state.db`:

- `sessions` — thread → opencode session mapping + cost totals
- `audit_log` — every command run
- `bookmarks` — 📌'd messages
- `background_jobs` — `/oc bg` queue + history
- `scheduled_tasks` — recurring tasks
- `meta` — kv (digest last-run date, etc.)
- `schema_version` — applied migrations

WAL mode is on (so reads don't block writes during long ops).

**On clean shutdown** (SIGTERM / SIGINT), the bot writes a copy to `${DATA_DIR}/state.db.backup` before closing the live connection. To restore: stop the service, `cp state.db.backup state.db`, restart.

**Schema migrations** run automatically on startup. Each migration is a transactional `db.exec` — a partial migration won't leave the DB inconsistent.

## CLI / npm scripts

| Command | What |
|---|---|
| `npm run dev` | Watch mode via `tsx`, loads `.env` if present. |
| `npm run build` | Compile TS → `dist/`. |
| `npm run start` | Run compiled bot (`dist/index.js`). Loads `.env` if present (production prefers systemd `EnvironmentFile`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Vitest unit tests (~85 currently). |
| `npm run test:watch` | Vitest in watch mode. |

---

## Things that are deliberately NOT in V1

- **Per-command authorization** — only allowlist auth. Adding a teammate gives them every command. (V2)
- **GitHub webhook auto-review on PR open** — would break Socket-Mode-only architecture. (V3 if needed)
- **Mid-session model swap** — `/oc model X` only takes effect on the next message; the live opencode subprocess keeps its current model. (Decisions §13)
- **Cancellation rollback** — ❌ kills the subprocess but does not undo files written, git commits, or external API calls. (Decisions §11)
- **Approve-via-👍 / retry-via-↻** — both require message-to-context tracking that hasn't been built. The 📌 reaction is the only non-cancel reaction shortcut for now.
- **Inline GitHub PR comments** — `/oc review` posts the review to Slack only, not as inline comments on the GH PR.
- **Multi-workspace** — one bot, one Slack app.

See [REQUIREMENT.md](./REQUIREMENT.md) Decisions section for the rationale on each.
