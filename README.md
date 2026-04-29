# OpenEral

Run Claude Code inside an isolated OpenShell sandbox using the published image:

```text
ghcr.io/sandys/openeral/sandbox:just-bash
```

No local source checkout or JavaScript toolchain is required for the normal user flow. Contributor workflows live in [BUILD.md](./BUILD.md).

## Prerequisites

- Docker is running.
- The [`openshell` CLI](https://github.com/NVIDIA/OpenShell-Community) is installed.
- `curl` is available for creating the optional StringCost presign.
- `ANTHROPIC_API_KEY` is set in the shell where you run `openshell`.

If you keep credentials in `.env`, load them first:

```bash
set -a
source .env
set +a
```

## Start Claude Code

```bash
export ANTHROPIC_API_KEY='sk-ant-...'

openshell gateway start

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- openeral
```

The first Claude Code launch may ask you to choose a theme, accept the security notice, trust `/sandbox`, and confirm API usage billing. After that, Claude opens with `HOME=/home/agent` inside the sandbox.

Without PostgreSQL, OpenEral uses embedded PGlite under `/home/agent/.openeral/data`. That state lives for the sandbox lifetime and is removed when you delete the sandbox.

## Add PostgreSQL Persistence

Use this when you want workspace files and Claude memory to survive sandbox deletion or follow you across machines. Sensitive home credentials and config such as `.ssh`, `.aws`, `.git-credentials`, `.npmrc`, and keyrings are intentionally not persisted.

For Supabase, use the pooler connection string from **Project Settings -> Database -> Connection pooler**. It looks like:

```text
postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Run:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'

# Compatibility with .env files that use POSTGRES_URL.
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell sandbox create --tty \
  --name openeral-claude \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- openeral

rm -f /tmp/openeral-db-url
```

OpenEral reads `/sandbox/db-url`, creates the `_openeral` schema, runs migrations, restores the persisted workspace into `/home/agent`, syncs changes during runtime, and does a final flush on shutdown. In Supabase, switch the Table Editor schema selector to `_openeral` to inspect the rows.

Reuse the same sandbox name on every machine, and point it at the same `DATABASE_URL`. OpenEral uses the OpenShell sandbox ID as the workspace ID, so `--name openeral-claude` is what makes the same PostgreSQL-backed home restore after deletion or from another host.

Do not pass the database URL through an OpenShell generic provider. PostgreSQL is raw TCP, so the credential must be delivered by `--upload`.

## Work on Host Project Files

OpenEral can read and write files on your host machine directly. Run once after the gateway starts (safe to re-run — skips if already done):

```bash
./scripts/gateway-ensure-mnt.sh
```

Then create the sandbox with `--project-path` pointing at your project:

```bash
openshell sandbox create --tty \
  --name openeral-claude \
  --from openeral-sandbox:dev \
  --provider claude --auto-providers \
  -- openeral --project-path /mnt/c/Users/dines/OneDrive/Desktop
```

Claude starts with that directory its working directory and can read and write all files inside it. No PostgreSQL required — changes go directly to your host filesystem.

Your host path inside the sandbox follows this mapping:

| Host location | Path inside sandbox |
|---|---|
| `C:\Users\alice\myproject` (WSL) | `/mnt/c/Users/alice/myproject` |
| `/home/alice/myproject` (Linux) | `/mnt/home/alice/myproject` |

The `--project-path` must be under `/mnt/`. Claude's home directory (`/home/agent`) stays inside the sandbox and holds settings, memory, and shell history for the session.

## Add StringCost Tracking

StringCost is optional. It routes Claude API calls through a presigned proxy URL for token and cost metering.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'

OPENERAL_INPUT="$(mktemp -d)"

curl -fsS https://app.stringcost.com/v1/presign \
  -H "Authorization: Bearer $STRINGCOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "client_api_key": "'"$ANTHROPIC_API_KEY"'",
    "path": ["/v1/messages"],
    "expires_in": -1,
    "max_uses": -1,
    "cost_limit": 10000000,
    "tags": ["openeral"]
  }' \
  > "$OPENERAL_INPUT/presign.json"

# Optional: combine PostgreSQL persistence in the same upload.
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"
if [ -n "${DATABASE_URL:-}" ]; then
  printf '%s' "$DATABASE_URL" > "$OPENERAL_INPUT/db-url"
fi

chmod -R go-rwx "$OPENERAL_INPUT"

openshell provider create --name stringcost --type generic \
  --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY" \
  || openshell provider update stringcost \
    --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY"

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload "$OPENERAL_INPUT:/sandbox/openeral-input" \
  --provider claude --provider stringcost --auto-providers \
  -- openeral

rm -rf "$OPENERAL_INPUT"
```

Create the presign on the host. Inside OpenShell, provider secrets are placeholders; they work for HTTP headers but not as JSON body values for StringCost's `client_api_key`.

---

## Start OpenClaw

OpenClaw is an alternative AI coding agent that runs in the same image. The `openclaw` provider is what signals the sandbox to launch OpenClaw instead of Claude Code.

Create the provider once (this is the only one-time step — the provider persists in your OpenShell gateway):

```bash
openshell provider create --name openclaw --type generic \
  --credential "OPENERAL_AGENT=openclaw" \
  || openshell provider update openclaw \
    --credential "OPENERAL_AGENT=openclaw"
```

Then start the sandbox:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'

openshell gateway start

openshell sandbox create --tty \
  --name openeral-openclaw \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider openclaw --auto-providers \
  -- openeral
```

`--auto-providers` picks up `ANTHROPIC_API_KEY` from your shell and injects it alongside the `openclaw` provider. Without PostgreSQL, OpenEral uses embedded PGlite for the session lifetime.

## Add PostgreSQL Persistence (OpenClaw)

Same connection string as Claude Code — the same `_openeral` schema and workspace table are used by both agents.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'

export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell sandbox create --tty \
  --name openeral-openclaw \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider openclaw --auto-providers \
  -- openeral

rm -f /tmp/openeral-db-url
```

Reuse `--name openeral-openclaw` on every machine and point it at the same `DATABASE_URL`. OpenEral uses the sandbox name as the workspace ID, so the same PostgreSQL-backed home restores after deletion or on another host.

## Work on Host Project Files (OpenClaw)

Run the same one-time gateway script as for Claude Code:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Pavitra-programmers/openeral/main/scripts/gateway-ensure-mnt.sh)
```

Then create the sandbox with `--project-path`:

```bash
openshell sandbox create --tty \
  --name openeral-openclaw \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider openclaw --auto-providers \
  -- openeral --project-path /mnt/c/Users/alice/Desktop/work/myproject
```

Host files are accessible at the same `/mnt/...` paths inside the sandbox:

| Host location | Path inside sandbox |
|---|---|
| `C:\Users\alice\myproject` (WSL) | `/mnt/c/Users/alice/myproject` |
| `/home/alice/myproject` (Linux) | `/mnt/home/alice/myproject` |

## Add StringCost Tracking (OpenClaw)

StringCost cost tracking is not supported for OpenClaw. OpenClaw authenticates directly with the Anthropic API using your `ANTHROPIC_API_KEY` — there is no presign proxy step. Use your Anthropic console's usage dashboard to monitor spend when running OpenClaw.

## Manage Sandboxes

```bash
openshell sandbox list
openshell sandbox connect <name>
openshell sandbox delete <name>
```

Run one-off commands through SSH config:

```bash
openshell sandbox ssh-config <name> > /tmp/openeral-sandbox-ssh

ssh -F /tmp/openeral-sandbox-ssh openshell-<name> \
  'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh'
```

Keep the `HOME=/home/agent` prefix. OpenShell SSH starts in `/sandbox`, while OpenEral state lives under `/home/agent`.

## Troubleshooting

**No active gateway / gateway not reachable** - run `openshell gateway start --recreate`. The `--recreate` flag handles a stopped or crashed gateway container without conflicts.

**Claude exits with `Input must be provided either through stdin or as a prompt argument`** - the command was run without an interactive terminal. Use a real terminal and keep `--tty` in the command.

**Claude says authentication failed** - set `ANTHROPIC_API_KEY` in the same shell that runs `openshell sandbox create`.

**Claude says credit balance is too low** - the Anthropic account for that key needs credits or billing enabled.

**Files disappear after `sandbox delete`** - PostgreSQL persistence was not enabled. Use the `/sandbox/db-url` upload flow above.

**Migration fails with `tunnel to ... denied - 403`** - the PostgreSQL host is not allowlisted in the image policy. Common Supabase pooler hosts are included. Other hosts require a custom image; see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

**Migration fails with `EAI_AGAIN` or a placeholder-looking database URL** - do not use a generic `db` provider for PostgreSQL. Upload the connection string file with `--upload /tmp/openeral-db-url:/sandbox/db-url`.

## Contributing

Architecture, image customization, source-development workflows, and tests are documented in [BUILD.md](./BUILD.md).
