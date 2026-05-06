# opencode-slack-bot

A custom Slack ↔ [OpenCode](https://opencode.ai) bot. Replaces `Soyuz0/opencode-slack`. See [`REQUIREMENT.md`](./REQUIREMENT.md) for the full design and the V1 decisions log.

What it does:

- Streams opencode responses into a Slack thread (one message, edited every ~1s)
- Slash commands: `/oc review <PR>`, `/oc qa <file>`, `/oc ship <task>`, `/oc explore`, `/oc plan`, `/oc model`, `/oc agent`, `/oc cost`, `/oc reset`, `/oc help`
- Free-form DMs run with the default agent
- React ❌ on a running message → cancels the subprocess (best-effort, no rollback)
- Long output uploads as a `.md` file instead of truncating
- SQLite-backed sessions survive restart; daily prune of rows older than 30d
- Per-thread cost cap; per-user / per-workspace cost rollups via `/oc cost`
- Allowlist auth (`ALLOWED_USERS`) and repo allowlist (`ALLOWED_REPOS`)

## Slack app setup

1. Create the app at [api.slack.com/apps](https://api.slack.com/apps) → "From scratch".
2. **Socket Mode** → Enable → generate an App-Level Token (`xapp-...`) with the `connections:write` scope.
3. **OAuth & Permissions** → add Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `commands`
   - `files:write`
   - `im:history`, `im:read`, `im:write`
   - `reactions:read`
4. **Event Subscriptions** → enable, then subscribe to bot events:
   - `app_mention`
   - `message.im`
   - `reaction_added`
5. **Slash Commands** → New Command:
   - Command: `/oc`
   - Short description: `OpenCode bot`
   - Usage hint: `<subcommand> [args]`
   - (No Request URL needed — Socket Mode pushes via the websocket.)
6. **Install App** to your workspace → grab the Bot Token (`xoxb-...`).
7. **Basic Information** → grab the Signing Secret.
8. Invite the bot to whichever channels you want it to listen in: `/invite @your-bot-name`.

## Configuration

All config is via environment variables. Copy [`.env.example`](./.env.example) to `.env` for local dev; in production, put the same values in the systemd `EnvironmentFile`.

| Variable | What |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_APP_TOKEN` | `xapp-...` (Socket Mode) |
| `SLACK_SIGNING_SECRET` | 32-char hex |
| `ALLOWED_USERS` | Comma-separated Slack user IDs (e.g. `U0B1FJ83SRM`) |
| `ALLOWED_REPOS` | Comma-separated absolute paths the bot may operate on |
| `OPENCODE_BIN` | Absolute path to `opencode` (e.g. `/opt/homebrew/bin/opencode` or `/root/.opencode/bin/opencode`) |
| `DEFAULT_REPO` | One of `ALLOWED_REPOS` — used when no `[repo]` arg given |
| `DEFAULT_AGENT` | Default agent for free-form DMs (default `general`) |
| `DATA_DIR` | Where SQLite lives (default `./data`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `MAX_COST_PER_SESSION_USD` | Per-thread hard limit; checked at each opencode `step_finish` (default `1.00`) |

## Local development

```bash
cp .env.example .env
$EDITOR .env
npm install
npm run dev
```

Then DM the bot or `@mention` it in a channel it has been invited to.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Watch mode via `tsx`, loads `.env` if present |
| `npm run build` | Compile TS → `dist/` |
| `npm run start` | Run compiled bot (production) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |

## Deploy on a Linux box (systemd)

```bash
# 1. Place the repo at /opt/opencode-slack-bot
sudo mkdir -p /opt/opencode-slack-bot
sudo chown "$USER" /opt/opencode-slack-bot
git clone <repo-url> /opt/opencode-slack-bot
cd /opt/opencode-slack-bot
npm ci
npm run build

# 2. Create a service user and a writable data directory
sudo useradd -r -s /bin/false opencode-bot
sudo mkdir -p /var/lib/opencode-slack-bot
sudo chown opencode-bot:opencode-bot /var/lib/opencode-slack-bot
sudo chown -R opencode-bot:opencode-bot /opt/opencode-slack-bot

# 3. Drop the env file (use DATA_DIR=/var/lib/opencode-slack-bot)
sudo cp .env.example /etc/opencode-slack-bot.env
sudo chmod 600 /etc/opencode-slack-bot.env
sudo $EDITOR /etc/opencode-slack-bot.env

# 4. Install and start the unit
sudo cp systemd/opencode-slack-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-slack-bot
sudo journalctl -u opencode-slack-bot -f
```

## Migrating from `Soyuz0/opencode-slack`

The Slack app stays the same — only the binary on the receiving end changes.

```bash
# 1. Stop the old bot, but keep the directory around for a week as a fallback
sudo systemctl stop opencode-slack
sudo systemctl disable opencode-slack
sudo mv /root/opencode-slack /root/opencode-slack.old

# 2. Update the Slack app (api.slack.com/apps → your app):
#    - Add Bot Token Scopes:    files:write, reactions:read
#    - Add Event Subscriptions: reaction_added
#    - Reinstall the app to apply scope changes
#    (Bot, app, and signing tokens stay valid — no need to regenerate.)

# 3. Bring up the new bot per "Deploy on a Linux box" above.
#    Copy the existing tokens from your old .env into /etc/opencode-slack-bot.env.

# 4. Verify
#    - DM the bot → expect a streamed reply ending with token/cost summary
#    - /oc help → expect the command list
#    - /oc review <PR> → expect a reviewer-agent run
#    - React ❌ on a running message → expect "🛑 Cancelled."

# 5. After a stable week, delete the old install
sudo rm -rf /root/opencode-slack.old
```

## Architecture pointer

```
Slack ──(Socket Mode)── @slack/bolt ── command dispatcher ── opencode subprocess
                              │            │                     │
                              │            └── SQLite (sessions, audit_log, cost rollups)
                              │
                              └── reaction_added → SIGTERM → SIGKILL
```

12 source files in `src/`. Each one stays small. See [`REQUIREMENT.md`](./REQUIREMENT.md) for design intent and the locked-in decisions.
