# OpenEral

Persistent home directory and database access for AI agents, backed by PostgreSQL.

## Run Claude Code with OpenEral

### Quickest: inside Claude Code

If you're already in Claude Code, just say:

> I want to run Claude Code using openeral-shell

Claude will handle the rest — it clones the repo, builds, and launches.

### From your terminal

```bash
git clone https://github.com/sandys/openeral.git
cd openeral/openeral-js
pnpm install && pnpm build
npx openeral
```

That's it. OpenEral starts the OpenShell gateway, creates the sandbox, and Claude Code launches inside it.

**Add cost tracking** with [StringCost](https://github.com/arakoodev/stringcost) — just set your StringCost API key:

```bash
export ANTHROPIC_API_KEY='@anthropic_api_key'
export STRINGCOST_API_KEY='@stringcost_api_key'

npx openeral
```

When `STRINGCOST_API_KEY` is set, OpenEral automatically presigns with StringCost and routes all API traffic through it. Costs are tracked automatically — no extra configuration needed.

**Add persistence** by setting `DATABASE_URL` — files then survive across sessions:

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/dbname'
npx openeral
```

Without `DATABASE_URL`, OpenEral still works — Claude Code runs normally with a local temp home, just without cross-session persistence or database access.

### Refresh Claude memory

Refresh Claude's native auto-memory files inside the OpenEral home:

```bash
cd openeral/openeral-js
pnpm install && pnpm build

npx openeral memory refresh
```

Focus the refresh on a specific topic:

```bash
npx openeral memory refresh --query "openshell proxy and policy"
```

This rewrites the native Claude memory directory for the current project under `~/.claude/projects/<project>/memory/` inside the OpenEral home, with a backup in `.openeral-memory-backups/` unless `--no-backup` is set. The ranking is lexical + freshness-based and does not require embeddings or extra providers.

### Via OpenShell

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/dbname'

openshell gateway start

openshell provider create \
  --name db --type generic --credential DATABASE_URL

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider db --provider claude --auto-providers \
  -- /opt/openeral/setup.sh
```

Stock OpenShell — no custom cluster or gateway images.

**Add Socket.dev package scanning** — register a Socket provider:

```bash
openshell provider create \
  --name socket --type generic --credential SOCKET_TOKEN

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider db --provider claude --provider socket --auto-providers \
  -- /opt/openeral/setup.sh
```

npm traffic routes through `registry.socket.dev` with credential injection via the OpenShell proxy. The sandbox never sees the real `SOCKET_TOKEN`.

**Add StringCost cost tracking** — presign your Anthropic key and pass the URL:

```bash
# Presign on the host
PRESIGN=$(curl -s -X POST \
  -H "Authorization: Bearer $STRINGCOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","client_api_key":"'"$ANTHROPIC_API_KEY"'","path":["/v1/messages"],"expires_in":-1,"max_uses":-1,"tags":["openeral"],"metadata":{"source":"openeral"}}' \
  https://app.stringcost.com/v1/presign)
STRINGCOST_URL=$(echo "$PRESIGN" | jq -r '.url' | sed 's|/v1/.*$||')

# Launch with StringCost
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider db --provider claude --auto-providers \
  -- env ANTHROPIC_BASE_URL="$STRINGCOST_URL" /opt/openeral/setup.sh
```

Claude's API traffic routes through StringCost for cost tracking. The OpenShell proxy rewrites the `x-api-key` placeholder to the real key — Claude picks its own model, no override.

## What you get

- **Isolated home** — Claude Code runs in its own `$HOME`, separate from your system
- **Cost tracking** (with `STRINGCOST_API_KEY`) — automatic API cost metering via [StringCost](https://github.com/arakoodev/stringcost)
- **Persistent home** (with `DATABASE_URL`) — files survive across sessions, backed by PostgreSQL
- **Database access** (with `DATABASE_URL`) — `pg "SELECT * FROM users LIMIT 5"` from Claude's bash
- **Automatic sync** (with `DATABASE_URL`) — file changes sync to PostgreSQL in the background
- **Package scanning** (with `SOCKET_TOKEN` via OpenShell) — npm routes through Socket.dev
- **Credential injection** (via OpenShell) — API keys never reach the sandbox; the proxy resolves placeholders at egress
- **Session isolation** — different `OPENERAL_WORKSPACE_ID` = different workspace
- **Memory refresh** — `openeral memory refresh` rewrites Claude's native project memory files in the isolated home

## Persistence (requires DATABASE_URL)

Same machine = same workspace (keyed to hostname by default).

```bash
# Session 1
npx openeral -- -p 'Run: printf "%s" "hello" > "$HOME/notes.txt" && echo WRITTEN' --dangerously-skip-permissions

# Session 2 — file is still there
npx openeral -- -p 'Run: cat "$HOME/notes.txt"' --dangerously-skip-permissions
# → hello
```

Use `Run:` Bash commands when you want shell expansion inside the isolated home. `$HOME` expands correctly in Bash; Claude's file tools do not reliably expand shell variables, and `~` may resolve to the OS user home.

Reliable pattern:

```bash
npx openeral -- -p 'Run: printf "%s" "hello" > "$HOME/notes.txt" && echo WRITTEN'
npx openeral -- -p 'Run: cat "$HOME/notes.txt"'
```

Multiple workspaces:

```bash
OPENERAL_WORKSPACE_ID=project-alpha npx openeral
```

`--` starts Claude's arguments. `npx openeral -- --help` passes `--help` to Claude, not to OpenEral. Use `npx openeral --help` for OpenEral help.

## Database access (requires DATABASE_URL)

Claude can query the connected database:

```bash
pg "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
pg "SELECT * FROM public.users LIMIT 5"
pg "\d public.users"
```

The `pg` command is automatically available — OpenEral writes a `CLAUDE.md` that teaches Claude how to use it.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required for Claude) | Anthropic API key |
| `STRINGCOST_API_KEY` | (optional) | StringCost API key — enables automatic cost tracking |
| `DATABASE_URL` | (optional) | PostgreSQL connection string — enables persistence and `pg` |
| `OPENERAL_WORKSPACE_ID` | hostname | Workspace identifier |
| `OPENERAL_HOME` | `/tmp/openeral-<id>` | Local workspace directory |

## How it works

```
                    ┌─────────────┐
PostgreSQL ◄──sync──┤ /home/agent ├──► Claude Code (Read, Write, Edit, Bash, ...)
                    └──────┬──────┘
                      file watcher
                           │
                    sync on change ──► PostgreSQL
```

On startup, OpenEral restores your workspace from PostgreSQL to a real directory. Claude Code runs normally — all its tools (Read, Write, Edit, Bash, Glob, Grep) work on real files. A background watcher syncs changes back to PostgreSQL. On exit, a final sync saves everything.

## Custom agents

For agents with a single bash tool (not the Claude Code CLI), use the just-bash virtual filesystem directly:

```typescript
import { createOpeneralShell, createToolHandler } from 'openeral-js'

const shell = await createOpeneralShell({
  connectionString: process.env.DATABASE_URL,
  workspaceId: 'my-session',
})

const handleBash = createToolHandler(shell)
await shell.exec('cat /db/public/users/.info/count')   // → "42\n"
await shell.exec('echo hello > /home/agent/notes.txt') // persisted
```

This path uses [just-bash](https://github.com/vercel-labs/just-bash) with PostgreSQL-backed virtual mounts at `/db` (read-only) and `/home/agent` (read-write).

## Build & test

```bash
cd openeral-js
pnpm install && pnpm build
pnpm check                    # typecheck + 29 lints + 78 unit tests

# Integration (requires PostgreSQL)
DATABASE_URL='...' node test-integration.mjs
DATABASE_URL='...' node test-memory-refresh.mjs

# Docker image verification (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh

# Setup.sh flow inside container (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh

# Real Claude Code persistence (requires PostgreSQL + ANTHROPIC_API_KEY)
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh
```

## Project structure

```
openeral-js/                  # TypeScript package
  src/bin/openeral.ts         # executable wrapper for npm/npx and scripts
  src/cli.ts                  # CLI parsing and command dispatch
  src/sync.ts                 # PostgreSQL ↔ filesystem sync
  src/shell.ts                # createOpeneralShell() for custom agents
  src/pg-fs/                  # Read-only /db filesystem
  src/workspace-fs/           # Read-write /home/agent filesystem
  src/db/                     # SQL queries, migrations
  src/safety.ts               # Command safety analysis
  lint.mjs                    # 29 structural lint rules

sandboxes/openeral/           # OpenShell sandbox image
  Dockerfile                  # Stock base + Node.js + openeral-js
  setup.sh                    # Sandbox entry point
  policy.yaml                 # Network policy
```
