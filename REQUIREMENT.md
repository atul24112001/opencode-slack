# SLACK_CODING_BOT_DESIGN.md

Design document for a custom Slack ↔ OpenCode bot, replacing the third-party `Soyuz0/opencode-slack` we've been using.

This is the spec we'll build from. No implementation code here yet — that comes during the pair-coding sessions. The point of this doc is to lock down *what* we're building and *why* before we start writing it.

---

## Why we're building this

We currently use `Soyuz0/opencode-slack` — a 1-star personal repo that I recommended without proper vetting. It works but has real friction (documented below) and "borrowed trust" problems for code that handles our Slack tokens, GitHub PAT, and shell access.

A custom build gives us:

- **Code we own and understand** — every line, no surprises.
- **Fixes for every pain point** we've already hit.
- **A foundation we can extend** as the bot becomes more central to our workflow.

Trade-off: ~400 lines of TypeScript to write and maintain. Acceptable for the control we get back.

---

## Pain points with the current bot

In rough order of how much they bite during real use:

1. **Hardcoded `-m anthropic/claude-opus-4-6` flag** — required source patching to work with DeepSeek. Will break again on any model swap.
2. **Slack 50-block message limit** — long PR reviews truncate mid-output with no fallback.
3. **No file attachment fallback** — when a review overflows, the content is just *lost*.
4. **Threaded replies feel cluttered** for personal use; flat replies would lose session context.
5. **In-memory sessions** — every restart wipes all conversation state.
6. **Silent failures** — when opencode crashes, the user sees nothing in Slack; you have to check `journalctl` to find out why.
7. **No streaming progress** — user waits 30+ seconds in silence. No "thinking..." indicator that updates.
8. **Folder picker** is unnecessary friction for our single-repo setup. Always tap "Use default."
9. **Single hardcoded user** (`ALLOWED_USER_ID`) — no clean way to add a teammate without code edits.
10. **No cost visibility** — find out next month you spent $50 instead of seeing it as it accrues.
11. **No cancellation** — once a task starts, you can't stop it. Have to wait or kill the systemd service.
12. **No clear command surface** — typing `use reviewer:` as a prefix every time is awkward and undiscoverable.
13. **No structured logging** — debug output is human-readable but not machine-parseable for alerts/aggregation.

---

## Must-have features (MVP — V1)

These collectively replace the current bot and fix the top pain points. This is what we ship in V1.

### Provider-agnostic by construction

No hardcoded `-m` flag. Whatever was set via `opencode /connect` is what runs. If the user wants to override per-thread:

```
/oc model deepseek-v4-pro
/oc model anthropic/claude-sonnet-4-5
```

Stored in the thread's session record, used for subsequent messages in that thread.

### Streaming progress

When a request comes in:

1. Post `🕐 _Thinking..._` immediately, react with hourglass emoji.
2. As opencode emits JSON events (`reasoning`, `tool-input`, `tool-output`, `text`), edit the same Slack message every ~600ms with accumulated output.
3. On completion: swap hourglass → ✅, edit message to remove the `_Thinking..._` indicator, append the cost summary.
4. On error: swap hourglass → ❌, replace message with the error.

This is the single biggest UX improvement over the current bot. Users see progress instead of silence.

### Smart output handling — never truncate

Three modes based on output size:

- **< 3000 chars / < 40 blocks**: post inline as Slack message (current behavior).
- **3000–10,000 chars**: post a short summary inline + upload full output as `<command>-<timestamp>.md` file via `files.uploadV2`.
- **> 10,000 chars**: same as above but truncate the inline summary further.

PR reviews become readable documents you can scroll, share, and link to.

### Persistent sessions

SQLite database at `~/.local/share/slack-coding-bot/state.db` with a single table:

```
sessions(
    thread_ts PRIMARY KEY,
    opencode_session_id,
    repo_path,
    model_override,
    agent_override,
    last_active_at,
    total_tokens,
    total_cost_usd
)
```

Survives restarts. A daily cron prunes rows where `last_active_at` > 30 days.

### Real error messages

Every error path posts to Slack with context:

- `❌ opencode exited with code 1: {stderr_tail}`
- `❌ Provider error: model 'foo' not found in your /connect config`
- `❌ Repo not found at /root/projects/<name>`

Logs still go to `journalctl` for deep debugging, but the user always knows what happened.

### Cancellation via reaction

User reacts ❌ on a running message → bot:

1. Sends SIGTERM to the opencode subprocess.
2. Waits 3s, then SIGKILL if still alive.
3. Replaces the message with `🛑 Cancelled. {partial_output_if_any}`.

Critical for runaway loops or "wrong agent picked up the task" mistakes.

### Slash commands

Discoverable, structured operations:

| Command | Description |
|---|---|
| `/oc review <PR-number> [repo]` | Run reviewer agent on a PR |
| `/oc qa <file-path> [repo]` | Generate tests for a file |
| `/oc ship <task description>` | Implement + branch + test + PR |
| `/oc explore <question>` | Read-only codebase exploration |
| `/oc plan <task>` | Plan without writing code |
| `/oc model [model-id]` | Show or set the model for this thread |
| `/oc agent [agent-name]` | Show or set the agent for this thread |
| `/oc cost` | Token + cost summary for this thread |
| `/oc reset` | Forget this thread's session |
| `/oc help` | Show all commands |

Plain DM messages still work (free-form chat with the default agent). Slash commands are for structured operations where it matters that arguments are clear.

### Single Socket Mode connection

Same architectural decision as the current bot — `@slack/bolt` in Socket Mode. **No public URL required, no inbound ports.** Slack pushes events to us via outbound websocket. Easier to secure on EC2, no reverse proxy, no certificate management.

---

## Nice-to-have features (V2)

Genuine improvements but not blocking V1 ship.

### Multi-user authorization

Two configurable modes:

- **Allowlist mode** (`AUTH_MODE=allowlist`): `ALLOWED_USERS=U123,U456,U789` in `.env`. Only those Slack user IDs can use the bot.
- **Workspace mode** (`AUTH_MODE=workspace`): bot calls `users.info` on the sender — anyone in your Slack workspace can use it. No allowlist needed.

Per-command authorization layered on top: `COMMAND_PERMISSIONS` JSON in `.env`:

```json
{
  "review": "*",
  "qa": "*",
  "ship": ["U123", "U456"],
  "model": ["U123"]
}
```

Reviewer = everyone, ship = trusted engineers only, model switching = admins only.

### Cost tracking

OpenCode emits token + cost data in every `step_finish` event. We aggregate:

- Per thread (`/oc cost`)
- Per user per day
- Workspace-wide per month

Stored in SQLite with rollups computed lazily.

Plus a hard limit: `MAX_COST_PER_SESSION_USD=1.00` in `.env`. If a session exceeds it, the bot refuses to continue and tells the user. Prevents runaway loops from draining the API balance.

### Repo allowlist

`ALLOWED_REPOS=/root/projects/repo-a,/root/projects/repo-b` in `.env`. The `dir:` prefix and `[repo]` argument in slash commands must match an allowlisted path. Prevents prompt injection from steering the bot to `/etc/` or `/root/.ssh/`.

### Audit log

SQLite table `audit_log`:

```
audit_log(
    timestamp,
    user_id,
    user_name,
    command,
    args,
    repo,
    duration_ms,
    exit_code,
    tokens,
    cost_usd,
    error
)
```

`/oc audit [N]` returns the last N entries (admin-only). Useful for "who told the bot to do that?" forensics.

### Better help and discoverability

`/oc help` returns a Block Kit message with:

- Quick-start examples
- All slash commands and what they do
- List of available agents (read from `.opencode/agents/`)
- Current model and provider
- Link to the design doc / README

Help should be the front door for every new user.

---

## Power features (V3 — only if heavy use)

These are real features for teams using the bot daily, not solo experiments.

### GitHub webhook integration

`/api/github/webhook` endpoint receives `pull_request: opened` events from GitHub, auto-triggers a review by posting `/oc review <PR-number>` to a configured channel.

**Trade-off:** breaks Socket-Mode-only architecture by requiring a public URL. Make it opt-in via `GITHUB_WEBHOOK_ENABLED=true`. If disabled, no inbound port is opened.

When enabled:
- Bind to localhost, fronted by Caddy/Nginx with TLS
- Verify GitHub webhook signatures (`X-Hub-Signature-256`)
- Allowlist source IPs to GitHub's published webhook ranges

### File upload as input

User uploads a file in Slack → bot reads it (`files.info` + download) → passes it as input to opencode. Useful for "review this design doc" or "extract requirements from this transcript."

### Background tasks

Long-running operations (full repo audits, big refactors) run in the background. The bot replies immediately with `🟡 Started background task. I'll DM you when done.` Then DMs the result whenever it finishes, even if it's an hour later.

Implementation: SQLite job queue, worker pool with concurrency limit. Small enough to run inside the same Node process.

### Notification preferences

Per-user settings via `/oc settings`:
- DM me when background tasks finish
- DM me on errors in shared channels
- Default agent / model

Stored in the SQLite `users` table.

### Scheduled tasks

`/oc schedule daily 9am "/oc review last 24h commits in repo-a"` — bot runs the command on a cron schedule, posts results to the originating channel/thread.

---

## Architecture

```
        Slack workspace
             │  (Socket Mode — outbound websocket)
             ▼
   ┌──────────────────────────────┐
   │  slack-coding-bot (Node)     │
   │  ┌────────────────────────┐  │
   │  │  @slack/bolt app       │  │
   │  │  - event handlers      │  │
   │  │  - slash commands      │  │
   │  │  - reaction handlers   │  │
   │  └───────────┬────────────┘  │
   │              │               │
   │  ┌───────────▼────────────┐  │
   │  │  command dispatcher    │  │
   │  └───────────┬────────────┘  │
   │              │               │
   │  ┌───────────▼────────────┐  │      ┌──────────┐
   │  │  opencode.spawn()      │──┼─────▶│ opencode │
   │  │  - parses JSON stream  │  │      │   CLI    │
   │  │  - handles cancel      │  │      └────┬─────┘
   │  └───────────┬────────────┘  │           │
   │              │               │           ▼
   │  ┌───────────▼────────────┐  │      ┌──────────┐
   │  │  formatter             │  │      │  Model   │
   │  │  - blocks for short    │  │      │ Provider │
   │  │  - file upload for big │  │      │   API    │
   │  └───────────┬────────────┘  │      └──────────┘
   │              │               │
   │  ┌───────────▼────────────┐  │
   │  │  SQLite (state.db)     │  │
   │  │  - sessions            │  │
   │  │  - audit_log           │  │
   │  │  - costs               │  │
   │  └────────────────────────┘  │
   └──────────────────────────────┘
              ▲
              │ (optional, V3)
              │
       GitHub webhooks → /api/github
```

Single Node process. All state is local (SQLite + opencode's own auth.json). No Redis, no external queue, no separate worker. Fits comfortably on a t3.small.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (ESM) | Catches the kind of "hardcoded model id" bugs that bit us. ESM because `@slack/bolt` v4+ ships ESM. |
| Slack SDK | `@slack/bolt` | Maintained by Slack. Handles Socket Mode, signing, retries. |
| Storage | `better-sqlite3` | Zero deps, file-based, sync API (no async juggling), fast enough. |
| Logger | `pino` | Structured JSON logs. Plays well with `journalctl -o json`. |
| Config validation | `zod` | Validate `.env` at startup, fail fast with clear errors. |
| HTTP server (V3 only) | `hono` | Tiny, fast, only needed if we add GitHub webhooks. |
| Tests | `vitest` | Fast, native TypeScript, ESM-friendly. |
| Process manager | `systemd` | Same as before. We're not introducing PM2 / Docker unless there's a reason. |

**What we're explicitly not using:**

- **No ORM.** SQLite + raw SQL is simpler and faster for this scale. Maybe 5 tables total.
- **No framework.** No NestJS, no Fastify. Bolt is enough; everything else is plain modules.
- **No Docker (yet).** systemd on EC2 is fine. Containers can come later if we want isolation.
- **No Redis.** All state fits in SQLite.

---

## File structure

```
slack-coding-bot/
├── src/
│   ├── index.ts              # entry point: load config, init bot, handle SIGTERM
│   ├── bot.ts                # @slack/bolt app, event routing
│   ├── config.ts             # zod schema for .env, validation on startup
│   ├── commands/
│   │   ├── index.ts          # registry / dispatcher
│   │   ├── review.ts
│   │   ├── qa.ts
│   │   ├── ship.ts
│   │   ├── explore.ts
│   │   ├── plan.ts
│   │   ├── model.ts
│   │   ├── agent.ts
│   │   ├── cost.ts
│   │   ├── reset.ts
│   │   └── help.ts
│   ├── opencode.ts           # spawn(), JSON event parser, cancellation
│   ├── formatter.ts          # JSON events → Slack blocks
│   ├── files.ts              # files.uploadV2 wrapper for long output
│   ├── sessions.ts           # thread→session mapping, SQLite-backed
│   ├── auth.ts               # ALLOWED_USERS / workspace check / per-command perms
│   ├── audit.ts              # audit log writer + reader
│   ├── cost.ts               # cost aggregation queries
│   ├── db.ts                 # SQLite init + migrations
│   └── types.ts              # shared types (OpenCodeEvent, etc.)
├── test/
│   ├── unit/
│   │   ├── formatter.test.ts
│   │   ├── opencode.test.ts
│   │   └── sessions.test.ts
│   └── e2e/
│       ├── mock-slack.ts
│       ├── mock-opencode.ts
│       └── full-flow.test.ts
├── systemd/
│   └── slack-coding-bot.service
├── scripts/
│   ├── migrate.ts            # SQLite schema migrations
│   └── prune-sessions.ts     # nightly cleanup
├── .env.example
├── .gitignore
├── package.json              # type: module, scripts, deps
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

12 source files for V1. Each one stays under 200 lines if we do it right.

---

## Implementation plan (pair-coding sessions)

We'll build it in this order. Each session ends with something working that we can test.

### Session 1: skeleton + bot replies "pong"

- `package.json`, `tsconfig.json`, install deps
- `config.ts` — zod schema, validates `.env` on import
- `db.ts` — SQLite init, runs migrations
- `bot.ts` — Bolt app, listens for `app_mention` and DM, replies "pong"
- `index.ts` — wires it together, handles SIGTERM
- Smoke test in Slack

**Outcome:** an empty bot that comes up cleanly and responds to messages.

### Session 2: opencode integration + streaming

- `opencode.ts` — spawn child process, parse `--format json` stream into typed events
- `formatter.ts` — events → Slack blocks (basic version, no file fallback yet)
- `bot.ts` — wire DM messages through opencode, edit message every 600ms
- `sessions.ts` — basic in-memory thread→session map (SQLite comes next session)

**Outcome:** DM the bot, get a streamed response. Basic version works end-to-end.

### Session 3: persistent sessions + slash commands

- `sessions.ts` — SQLite-backed, prunes old rows
- `commands/index.ts` — dispatcher
- `commands/review.ts`, `commands/qa.ts`, `commands/ship.ts` — wrap message text with the right agent prefix
- `commands/model.ts`, `commands/agent.ts` — per-thread overrides
- `commands/help.ts`

**Outcome:** Slash commands work, sessions survive restart.

### Session 4: file upload fallback + error handling + cancellation

- `files.ts` — `files.uploadV2` wrapper
- `formatter.ts` — switches to file mode when output is large
- Error paths in `bot.ts` — every catch posts to Slack with ❌
- Reaction handler — ❌ on a running message → SIGTERM the subprocess

**Outcome:** Long PR reviews work. Errors are visible. Cancellation works. **V1 is ready to deploy.**

### Session 5: tests + systemd + migration from old bot

- Vitest unit tests for formatter, sessions, opencode parser
- E2E test with mock Slack and mock opencode
- `systemd/slack-coding-bot.service`
- README with deploy instructions
- Migration: stop old bot, start new bot, verify

**Outcome:** Production-ready V1.

### Sessions 6+: V2 features (auth, cost tracking, repo allowlist, audit log)

Each is roughly one session.

### Session N+: V3 features (GitHub webhook, file upload as input, background tasks)

Only if/when we want them.

---

## Migration plan from current bot

When V1 is ready:

1. Stop `opencode-slack` systemd unit: `sudo systemctl stop opencode-slack`
2. Disable: `sudo systemctl disable opencode-slack`
3. Keep the directory around for reference: `mv ~/opencode-slack ~/opencode-slack.old`
4. The Slack app stays the same. Same tokens. Same scopes. Same Socket Mode.
5. Drop the new bot in `~/slack-coding-bot/`, copy `.env` values across, install the new systemd unit.
6. `sudo systemctl daemon-reload && sudo systemctl enable --now slack-coding-bot`
7. DM the bot — verify it works.
8. After a week of stable operation, delete `~/opencode-slack.old`.

Zero Slack-side changes. The Slack app doesn't know or care which bot binary is on the receiving end.

---

## UX preview (what V1 will feel like)

DM the bot:

```
You: /oc review 142

Bot (immediately, with 🕐 reaction):
🕐 _Thinking..._

Bot (edits at ~600ms intervals):
🕐 Reading PR #142 — 8 changed files in src/auth/...
🕐 Examining src/auth/jwt.ts...
🕐 Drafting review...

Bot (final edit, swaps 🕐 → ✅):
**Review for PR #142 — Refactor JWT validation**

**Summary**
Consolidates JWT validation into a shared utility used by both the API
middleware and the WebSocket auth handler.

**Correctness**
- src/auth/jwt.ts:42 — `expiresAt` comparison uses `<` but should be `<=`,
  causing tokens to be rejected one second before they should be.
- src/auth/middleware.ts:88 — Race condition if two requests arrive
  simultaneously and both trigger token refresh. Recommend a mutex.

**Tests**
- No tests for the new shared utility. Should add unit coverage for the
  expiry edge case (item 1 above) and the concurrent refresh scenario.

**Verdict**: request changes — issue 1 is a real bug.

24,103 tokens · $0.0087 · 18.2s
```

If the review is too long for blocks:

```
Bot:
✅ Review complete — uploaded as review-pr-142.md

[file attachment: review-pr-142.md, 47KB]

Verdict: request changes (3 issues, 1 critical). 87,432 tokens · $0.031.
```

To cancel a running task:

```
Bot:
🕐 Running ship: bump axios to latest, fix breakage...

[user reacts ❌]

Bot:
🛑 Cancelled. Branch fix/axios-bump was created but no commits made.
```

To check costs:

```
You: /oc cost

Bot:
**This thread:** 87,432 tokens · $0.0312
**You today:** 412,108 tokens · $0.1487
**Workspace this month:** 8.4M tokens · $3.08
**Session limit:** $1.00 (you've used 3.1%)
```

---

## Decisions

These resolve the original open questions and lock down implementation specifics. Anything not listed here is still up for grabs.

### Architecture & stack

1. **Storage:** SQLite via `better-sqlite3`. Atomic writes, queryable for cost rollups, ~5 tables total. JSON file would mean hand-rolling concurrency once V2 lands.
2. **TypeScript strictness:** `strict: true` + `noUncheckedIndexedAccess: true`. The verbosity catches exactly the "hardcoded model assumed valid" class of bug that motivated the rewrite.
3. **Node version:** pin Node 20 LTS via `.nvmrc` and `engines.node` in `package.json`. Bolt v4 + better-sqlite3 native bindings need >=20.

### Scope of V1

4. **Multi-repo + repo allowlist in V1.** `ALLOWED_REPOS` env var enforced at command dispatch. `repo_path` is already in the sessions schema. Closes a real path-injection hole without much extra code.
5. **Minimal allowlist auth in V1.** `ALLOWED_USERS` env var (comma-separated Slack user IDs). Per-command permissions defer to V2 — adding a teammate later shouldn't require rewriting every handler.
6. **Minimal audit log in V1.** Append-only `(ts, user_id, command, repo, exit_code, duration_ms)`. Five lines of insert per request. Full V2 schema (with tokens/cost/error blob) comes later.
7. **No GitHub webhook scaffolding now.** Defer until/unless we explicitly want it. When that day comes, it's one new file (`webhook.ts`) — not a refactor. No HTTP server in V1.

### Provider & cost

8. **Provider-agnostic cost storage.** Persist opencode's reported `total_tokens` + `total_cost_usd` from `step_finish` events as-is. No provider-specific pricing math in the bot. If we ever want per-provider breakdowns, it's a query, not a schema change.
9. **`MAX_COST_PER_SESSION_USD` is post-hoc.** Enforced at `step_finish`, so a single runaway step can overshoot before the bot refuses the next one. Documented in README. Pre-flight checks would require changes inside opencode itself.

### Slack interaction model

10. **Streaming edits serialize per-channel at 1/sec.** Drop intermediate frames if a new event arrives while an edit is in flight. Simpler than coalescing; fine for V1's single-stream usage. Avoids `chat.update` rate limits.
11. **Cancellation is best-effort.** ❌ reaction → SIGTERM → 3s grace → SIGKILL. **No rollback** of side effects (files written, git commits, external API calls). User verifies. Documented in `/oc help` output and README.
12. **❌ reaction scoping.** Only handled when (a) the reacted message was authored by the bot AND (b) the message is currently in the in-memory `active_streams` map. Everything else ignored.
13. **`/oc model` mid-session: takes effect on the next message.** Live opencode session keeps its current model. Bot replies "Model switched to X — applies on your next message in this thread."
14. **Default agent for free-form DMs:** `general` (opencode's default). Configurable via `DEFAULT_AGENT` env. Per-thread overridable via `/oc agent`.

### Output handling

15. **File-upload threshold:** 35 blocks OR 8000 chars, whichever hits first. Block count is the real ceiling (Slack max is 50 with headroom); char count is the secondary trigger for code-heavy outputs. Both are code constants — not env-tunable.
16. **`MAX_OUTPUT_LENGTH` env var dropped.** Replaced by the two code constants above (`INLINE_BLOCK_LIMIT`, `INLINE_CHAR_LIMIT`).

### Operational details

17. **SQLite prune is in-process.** Daily `setInterval` inside the bot. No separate cron script, no `SQLITE_BUSY` race with the live process.

---

## Success criteria for V1

We'll know V1 is done when:

- ✅ DMing the bot and using `/oc review <pr>`, `/oc qa <file>`, `/oc ship <task>` all work end-to-end.
- ✅ Long output uploads as a `.md` file instead of truncating.
- ✅ Bot survives a `systemctl restart` and remembers thread context.
- ✅ Errors from opencode appear in Slack with ❌, not just in journalctl.
- ✅ Reacting ❌ kills a running task.
- ✅ Cost summary appears at the end of every response.
- ✅ Old bot is decommissioned and we haven't missed it for a week.

---

## Appendix: configuration reference

`.env` for V1:

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Auth — V1 ships with allowlist (per Decisions §5)
ALLOWED_USERS=U0B1FJ83SRM
ALLOWED_REPOS=/root/projects/selection-portal,/root/projects/repo-b

# OpenCode
OPENCODE_BIN=/root/.opencode/bin/opencode
DEFAULT_REPO=/root/projects/selection-portal
DEFAULT_AGENT=general

# Storage
DATA_DIR=/root/.local/share/slack-coding-bot

# Logging
LOG_LEVEL=info   # debug | info | warn | error

# Limits
MAX_COST_PER_SESSION_USD=1.00
# (output-size threshold lives in code as INLINE_BLOCK_LIMIT / INLINE_CHAR_LIMIT — Decisions §15-16)
```

`.env` additions for V2:

```bash
AUTH_MODE=allowlist   # or 'workspace'
COMMAND_PERMISSIONS={"ship":["U123"],"*":"*"}
```

`.env` additions for V3:

```bash
GITHUB_WEBHOOK_ENABLED=true
GITHUB_WEBHOOK_SECRET=...
GITHUB_WEBHOOK_PORT=8080
```

---

