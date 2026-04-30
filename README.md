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

## Add StringCost Tracking

StringCost is optional. It routes Claude API calls through a presigned proxy URL for token and cost metering. Both Claude Code and OpenClaw can route through StringCost — set the `metadata.labels` entry below to `claude-code` or `openclaw` so the StringCost vendor portfolio attributes the spend to the right agent.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'

OPENERAL_INPUT="$(mktemp -d)"

# Use 'claude-code' for Claude Code; switch to 'openclaw' when launching OpenClaw.
AGENT_LABEL='claude-code'

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
    "metadata": { "source": "openeral-sandbox", "client": "'"$AGENT_LABEL"'", "labels": ["openeral", "'"$AGENT_LABEL"'"] }
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
  --from ghcr.io/pavitra-programmers/openeral/sandbox:just-bash \
  --provider openclaw --auto-providers \
  -- openeral
```

`--auto-providers` picks up `ANTHROPIC_API_KEY` from your shell and injects it alongside the `openclaw` provider. Without PostgreSQL, OpenEral uses embedded PGlite for the session lifetime.

> **If Claude Code launches instead of OpenClaw**, the `openclaw` provider was not created or was not passed. Run the `openshell provider create` command above (one-time) and ensure you pass `--provider openclaw` in the sandbox create command.

To route OpenClaw through StringCost the same way Claude Code does, follow [Add StringCost Tracking](#add-stringcost-tracking) but set `AGENT_LABEL='openclaw'` so the presign is tagged for the OpenClaw vendor row in StringCost's portfolio.

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

## Add StringCost Tracking (OpenClaw)

Follow the [Add StringCost Tracking](#add-stringcost-tracking) steps above with `AGENT_LABEL='openclaw'`. The presign flow is identical — `setup.sh` routes OpenClaw's Anthropic API calls through the StringCost proxy when `ANTHROPIC_BASE_URL` is set, and the `openclaw` label in `metadata.labels` attributes usage to the OpenClaw row in the StringCost vendor portfolio.

## Run Both Agents in One Sandbox

Pass `--shell` to start a sandbox where you can launch either Claude Code or OpenClaw from an interactive bash prompt:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'

openshell gateway start

openshell sandbox create --tty \
  --name openeral \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- openeral --shell
```

After setup completes you land in a bash shell inside the sandbox. Run whichever agent you want:

```bash
claude       # start Claude Code
openclaw     # start OpenClaw
```

To reconnect to the same sandbox in a later terminal session:

```bash
openshell sandbox connect openeral
```

PostgreSQL persistence and StringCost tracking compose with `--shell` the same way as the agent-specific commands — add `--upload /tmp/openeral-db-url:/sandbox/db-url` for persistence, or upload a presign file via `--upload "$OPENERAL_INPUT:/sandbox/openeral-input"` for StringCost. When StringCost is active, `ANTHROPIC_BASE_URL` is exported to the shell (and written to `~/.openeral/env.sh`), so both `claude` and `openclaw` route through the proxy automatically.

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
