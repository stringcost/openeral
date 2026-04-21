# BUILD.md — Local development for OpenEral

This file is for **contributors and developers** who want to modify OpenEral, build the sandbox image locally, or run the test suite. End users should follow [README.md](./README.md) — the published GHCR image is the supported path.

---

## Prerequisites

- Node.js 18 or later
- pnpm (`npm install -g pnpm`)
- Docker (for building the sandbox image and running E2E tests)
- A reachable PostgreSQL instance (for integration tests — Supabase, local postgres container, or any other)

---

## Clone and build

```bash
git clone https://github.com/sandys/openeral.git
cd openeral/openeral-js
pnpm install
pnpm build
```

This compiles TypeScript into `openeral-js/dist/`. The `dist/bin/openeral.js` script is what `npx openeral` resolves to when the package is published, and what the sandbox image runs internally.

---

## Run the CLI without a sandbox

The `openeral-js` package exposes a CLI that launches Claude Code locally, starts the OpenShell gateway, and creates a sandbox — all wrapped into one command. For day-to-day development this is quicker than invoking `openshell` by hand each time.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
npx openeral
```

By default this **pulls the published GHCR image** `ghcr.io/sandys/openeral/sandbox:just-bash`. To use a locally-built image instead, add `--dev`:

```bash
npx openeral --dev        # uses openeral-sandbox:dev (you must build it first)
npx openeral -d           # shorthand
```

**Build the dev image locally:**

```bash
# From the repo root
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:dev .
```

Override the dev image name via env var (if you tagged it differently):

```bash
OPENERAL_DEV_IMAGE=my-image:tag npx openeral --dev
```

---

## CLI subcommands (local development)

All subcommands accept `--dev`/`-d` to target the local dev image.

| Command | Description |
|---|---|
| `npx openeral` | Launch Claude Code (published image) |
| `npx openeral --dev` | Launch Claude Code (local dev image) |
| `npx openeral presign` | Show the currently stored StringCost presign |
| `npx openeral presign renew` | Create a new permanent StringCost presign and store it |
| `npx openeral stats` | API usage statistics (cost, tokens, model distribution, cache hit rate) |
| `npx openeral analyze` | Analyze session history and produce ranked optimization proposals |
| `npx openeral apply` | Auto-apply proposals from `analyze` — patches `CLAUDE.md`, creates `CONTEXT.md`, compacts memory |
| `npx openeral apply --dry-run` | Preview `apply` changes without writing |
| `npx openeral apply --proposal <id>` | Apply a single proposal (`model-routing`, `context-file`, `lazy-reading`, `readme-updates`, `memory-compact`) |
| `npx openeral memory refresh` | Rewrite Claude's native project memory files |
| `npx openeral memory refresh --query "..."` | Focus memory refresh on a specific topic |
| `npx openeral -- <args>` | Pass arguments straight to Claude (e.g. `npx openeral -- -p 'hello'`) |

**Options shared by `stats`, `analyze`, `apply`:**

```
--workspace <id>    Workspace ID (default: hostname)
--days <n>          Days of history to look back (default: 7)
--project-root <p>  Project root for analyze/apply (default: cwd)
--json              Output as JSON (analyze only)
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `STRINGCOST_API_KEY` | (optional) | StringCost key — enables cost tracking |
| `DATABASE_URL` | (optional) | PostgreSQL connection string — enables persistence and `pg` |
| `OPENERAL_WORKSPACE_ID` | hostname | Workspace identifier |
| `OPENERAL_HOME` | `/tmp/openeral-<id>` | Local workspace directory |
| `OPENERAL_SANDBOX_IMAGE` | `ghcr.io/sandys/openeral/sandbox:just-bash` | Override the production sandbox image |
| `OPENERAL_DEV_IMAGE` | `openeral-sandbox:dev` | Override the dev sandbox image (used with `--dev`/`-d`) |

---

## Test suite

```bash
cd openeral-js
pnpm check                    # typecheck + lints + unit tests
```

### Integration tests (require PostgreSQL)

```bash
export DATABASE_URL='postgresql://...'
node test-integration.mjs
node test-memory-refresh.mjs
```

### Docker image verification (requires Docker + PostgreSQL)

```bash
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh
```

Builds the image, runs checks inside it as the sandbox user: permissions, migrations, daemon, dist/ artifacts, user .npmrc preservation.

### Setup.sh flow inside container (requires Docker + PostgreSQL)

```bash
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh
```

Exercises the actual `setup.sh` code path end-to-end inside the container.

### Real Claude Code persistence (requires PostgreSQL + ANTHROPIC_API_KEY)

```bash
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh
```

Launches Claude Code through the built binary, has it write a file, deletes the home directory, relaunches, and verifies the file is restored from PostgreSQL.

---

## Custom agents (library usage)

For agents with a single bash tool (not the Claude Code CLI), you can use the just-bash virtual filesystem directly:

```typescript
import { createOpeneralShell, createToolHandler } from 'openeral-js'

const shell = await createOpeneralShell({
  connectionString: process.env.DATABASE_URL,
  workspaceId: 'my-session',
})

const handleBash = createToolHandler(shell)
await shell.exec('cat /db/public/users/.info/count')
await shell.exec('echo hello > /home/agent/notes.txt')
```

This path uses [just-bash](https://github.com/vercel-labs/just-bash) with PostgreSQL-backed virtual mounts at `/db` (read-only) and `/home/agent` (read-write).

---

## Project structure

```
openeral-js/                  # TypeScript package
  src/bin/openeral.ts         # executable wrapper for npm/npx
  src/cli.ts                  # CLI parsing and command dispatch
  src/sync.ts                 # PostgreSQL ↔ filesystem sync
  src/shell.ts                # createOpeneralShell() for custom agents
  src/pg-fs/                  # Read-only /db filesystem
  src/workspace-fs/           # Read-write /home/agent filesystem
  src/memory/                 # Claude project-memory refresh
  src/optimize/               # analyze / apply / stats subcommands
  src/db/                     # SQL queries, migrations
  src/safety.ts               # Command safety analysis
  lint.mjs                    # structural lint rules

sandboxes/openeral/           # OpenShell sandbox image
  Dockerfile                  # Stock base + Node.js + openeral-js
  setup.sh                    # Sandbox entry point
  policy.yaml                 # Network policy

tests/                        # End-to-end test scripts
  test_sandbox_e2e.sh         # Docker image verification
  test_setup_e2e.sh           # setup.sh flow inside container
  test_claude_e2e.sh          # Real Claude Code persistence
```

---

## Publishing a new image

Images are built and pushed by GitHub Actions on push to the `just-bash` branch (see `.github/workflows/publish-images.yml`). The tag `ghcr.io/sandys/openeral/sandbox:just-bash` always tracks the latest successful build on that branch.

To test before pushing:

```bash
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:dev .
bash tests/test_sandbox_e2e.sh
bash tests/test_setup_e2e.sh
ANTHROPIC_API_KEY='...' DATABASE_URL='...' bash tests/test_claude_e2e.sh
```
