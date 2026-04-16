# OpenEral

Isolated home directory and optional database access for AI agents. Runs on embedded PGlite by default — no PostgreSQL setup needed.

## Run Claude Code with OpenEral

### From your terminal

```bash
git clone https://github.com/sandys/openeral.git
cd openeral/openeral-js
npm install && npm run build
npx openeral
```

`npx openeral` uses the published Docker image `ghcr.io/sandys/openeral/sandbox:just-bash` — no local Docker build required. OpenEral starts the OpenShell gateway, pulls the published image, creates the sandbox, and Claude Code launches inside it.

**Add cost tracking** with [StringCost](https://stringcost.com):

```bash
export ANTHROPIC_API_KEY='[your-anthropic-api-key]'
export STRINGCOST_API_KEY='[your-stringcost-api-key]'

# First time only — creates a permanent presign (never expires) and saves it
npx openeral presign renew

# All future launches reuse the stored presign automatically
npx openeral
```

The presign is stored in `~/.config/openeral/presign.json` with `expires_in=-1, max_uses=-1, cost_limit=$10` — it never expires or exhausts by session count. Every session reuses it; no new presign is created on each launch.

**How `npx openeral` works:**

1. Starts the OpenShell gateway (a k3s cluster inside Docker) if not already running
2. Checks `~/.config/openeral/presign.json` for a stored [StringCost](https://stringcost.com) presign — reuses it if present, creates one on first launch if `STRINGCOST_API_KEY` is set
3. Creates a sandbox pod from the openeral image, runs `setup.sh` inside it
4. `setup.sh` starts the embedded PGlite database, runs migrations, seeds your workspace, then launches Claude Code
5. Claude's API calls route through the StringCost proxy URL — token counts and costs are logged automatically

No PostgreSQL required. PGlite runs entirely in-process inside the sandbox.

**Add persistence across sessions** by connecting an external PostgreSQL database:

```bash
export DATABASE_URL='postgresql://[username]:[password]@[host]:[port]/[database]'
npx openeral
```

Without `DATABASE_URL`, OpenEral uses embedded PGlite — Claude Code runs fully, files are persisted within the session, but the workspace resets on next launch.

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

**Add StringCost cost tracking** — create the presign once, then read it from the stored file:

```bash
# Create the permanent presign (do this once)
npx openeral presign renew

# Read the stored base URL
STRINGCOST_URL=$(node -e "const f=require('fs'),d=JSON.parse(f.readFileSync(require('os').homedir()+'/.config/openeral/presign.json','utf8'));console.log(d.url.replace(/\\/v1\\/.*\$/,''))")

# Launch with StringCost
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider db --provider claude --auto-providers \
  -- env ANTHROPIC_BASE_URL="$STRINGCOST_URL" /opt/openeral/setup.sh
```

Claude's API traffic routes through StringCost for cost tracking.

## Commands

All commands work with the published image by default. Add `--dev` (or `-d`) to use your locally-built image instead.

| Command | Description |
|---|---|
| `npx openeral` | Launch Claude Code (published image `ghcr.io/sandys/openeral/sandbox:just-bash`) |
| `npx openeral --dev` | Launch Claude Code (local dev image `openeral-sandbox:dev`) |
| `npx openeral presign` | Show the currently stored StringCost presign (URL, session ID, created date) |
| `npx openeral presign renew` | Create a new permanent presign and store it — prompts for API keys if not in env |
| `npx openeral stats` | Show API usage statistics (cost, tokens, model distribution, cache hit rate) |
| `npx openeral analyze` | Analyze session history and project files, produce ranked optimization proposals |
| `npx openeral apply` | Auto-apply proposals from `analyze` — patches `CLAUDE.md`, creates `CONTEXT.md`, compacts memory files |
| `npx openeral apply --dry-run` | Preview what `apply` would change without writing anything |
| `npx openeral apply --proposal <id>` | Apply a single proposal by ID (`model-routing`, `context-file`, `lazy-reading`, `readme-updates`, `memory-compact`) |
| `npx openeral memory refresh` | Rewrite Claude's native project memory files in the isolated home |
| `npx openeral -- <args>` | Pass arguments directly to Claude (e.g. `npx openeral -- -p 'hello'`) |

**Options shared by `stats`, `analyze`, `apply`:**

```bash
--workspace <id>    Workspace ID (default: hostname)
--days <n>          Days of history to look back (default: 7)
--project-root <p>  Project root for analyze/apply (default: cwd)
--json              Output as JSON (analyze only)
```

### Usage analytics

After running sessions via `npx openeral`, check what was spent:

```bash
npx openeral stats
```

```
Openeral - Usage Statistics (last 7 days)
════════════════════════════════════════════════════════════
COST
  Total spent:             $0.760890

TOKEN USAGE
  Total input tokens:      7,315
  Total API calls:         55

MODEL DISTRIBUTION
  Sonnet:  47 calls (85%)
  Haiku:   8 calls (15%)

CACHE PERFORMANCE
  Cache hits:  47 / 55 calls (85%)
```

`stats` syncs live data from [StringCost](https://stringcost.com) automatically before displaying (requires `STRINGCOST_API_KEY`).

Analyze your sessions and get ranked proposals to reduce token usage in future sessions:

```bash
npx openeral analyze
```

This reads your session history from the local database and scans your `CLAUDE.md` and memory files. It produces proposals like adding model-routing rules (use Haiku for simple reads, Sonnet for coding), creating a `CONTEXT.md` so Claude doesn't re-explore your project every session, and compacting memory files.

Apply all proposals automatically:

```bash
npx openeral apply           # apply all auto-applicable proposals
npx openeral apply --dry-run # preview changes first
npx openeral apply --proposal model-routing   # apply one specific proposal
```

`apply` patches your `CLAUDE.md` and creates `.claude/CONTEXT.md` — all changes are idempotent (safe to re-run).

## What you get

- **Isolated home** — Claude Code runs in its own `$HOME`, separate from your system
- **Embedded database** — PGlite runs in-process with no setup; workspace state is always persisted within a session
- **Cost tracking** (with `STRINGCOST_API_KEY`) — automatic API cost metering via [StringCost](https://stringcost.com), one permanent presign reused across all sessions
- **Cross-session persistence** (with `DATABASE_URL`) — files survive across launches, backed by external PostgreSQL
- **Database access** (with `DATABASE_URL`) — `pg "SELECT * FROM users LIMIT 5"` from Claude's bash
- **Usage analytics** — `npx openeral stats` / `analyze` / `apply` to track spend and reduce token usage
- **Package scanning** (with `SOCKET_TOKEN` via OpenShell) — npm routes through Socket.dev
- **Credential injection** (via OpenShell) — API keys never reach the sandbox; the proxy resolves placeholders at egress
- **Session isolation** — different `OPENERAL_WORKSPACE_ID` = different workspace
- **Memory refresh** — `openeral memory refresh` rewrites Claude's native project memory files in the isolated home

## Persistence

By default, OpenEral uses embedded PGlite — no `DATABASE_URL` needed. Files written during a session are kept in the workspace, but the workspace is recreated fresh on next launch.

For files that survive across launches, connect an external PostgreSQL database via `DATABASE_URL`.

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
| `OPENERAL_SANDBOX_IMAGE` | `ghcr.io/sandys/openeral/sandbox:just-bash` | Override the production sandbox image |
| `OPENERAL_DEV_IMAGE` | `openeral-sandbox:dev` | Override the dev sandbox image (used with `--dev`/`-d`) |

## How it works

```
                    ┌─────────────┐
  PGlite/PG ◄──sync─┤ /home/agent ├──► Claude Code (Read, Write, Edit, Bash, ...)
                    └──────┬──────┘
                      file watcher
                           │
                    sync on change ──► PGlite/PG
```

On startup, OpenEral restores your workspace from the embedded PGlite database (or external PostgreSQL if `DATABASE_URL` is set) to a real directory. Claude Code runs normally — all its tools (Read, Write, Edit, Bash, Glob, Grep) work on real files. A background watcher syncs changes back to the database. On exit, a final sync saves everything.

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

## Development

For contributors who want to test local changes to the sandbox image.

**Build the dev image:**

```bash
# From the repo root
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:dev .
```

**Launch with the local dev image:**

```bash
npx openeral --dev                  # launch (local image)
npx openeral -d                     # same, short flag

# All subcommands accept --dev/-d
npx openeral --dev presign
npx openeral --dev presign renew
npx openeral --dev stats
npx openeral --dev analyze
npx openeral --dev apply
npx openeral --dev apply --dry-run
npx openeral --dev -- -p 'hello'
```

Override the dev image name via env var (if you tagged it differently):

```bash
OPENERAL_DEV_IMAGE=my-image:tag npx openeral --dev
```

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
