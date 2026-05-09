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
- `DATABASE_URL` points at an external PostgreSQL (Supabase, Neon, etc.). OpenEral has no embedded database — workspaces always live in PostgreSQL.

If you keep credentials in `.env`, load them first:

```bash
set -a
source .env
set +a
```

For Supabase, use the pooler connection string from **Project Settings -> Database -> Connection pooler**. It looks like:

```text
postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Sensitive home credentials and config such as `.ssh`, `.aws`, `.git-credentials`, `.npmrc`, and keyrings are intentionally not persisted.

## Start Claude Code

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'

# Compatibility with .env files that use POSTGRES_URL.
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell gateway start

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- openeral

rm -f /tmp/openeral-db-url
```

The first Claude Code launch may ask you to choose a theme, accept the security notice, trust `/sandbox`, and confirm API usage billing. After that, Claude opens with `HOME=/home/agent` inside the sandbox.

OpenEral reads `/sandbox/db-url`, creates the `_openeral` schema, runs migrations, restores the persisted workspace into `/home/agent`, syncs changes during runtime, and does a final flush on shutdown. In Supabase, switch the Table Editor schema selector to `_openeral` to inspect the rows.

Reuse the same sandbox name on every machine, and point it at the same `DATABASE_URL`. OpenEral uses the OpenShell sandbox ID as the workspace ID, so `--name openeral-claude` is what makes the same PostgreSQL-backed home restore after deletion or from another host.

Do not pass the database URL through an OpenShell generic provider. PostgreSQL is raw TCP, so the credential must be delivered by `--upload`.

## Add StringCost Tracking

StringCost is optional. It routes Claude Code API calls through a presigned proxy URL for token and cost metering.

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
    "metadata": { "source": "openeral-sandbox", "client": "claude-code", "labels": ["openeral", "claude-code"] }
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
  --provider claude --auto-providers \
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

OpenClaw uses the same `_openeral` schema as Claude Code. Both `ANTHROPIC_API_KEY` and `DATABASE_URL` must be delivered as uploaded files — OpenShell provider credentials arrive as opaque placeholders that OpenClaw's gateway cannot resolve, and PostgreSQL is raw TCP that needs the literal connection string.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

OPENERAL_INPUT="$(mktemp -d)"
printf '%s' "$ANTHROPIC_API_KEY" > "$OPENERAL_INPUT/anthropic-api-key"
printf '%s' "$DATABASE_URL"      > "$OPENERAL_INPUT/db-url"
chmod -R go-rwx "$OPENERAL_INPUT"

openshell gateway start

openshell sandbox create --tty --name openeral-openclaw \
  --from ghcr.io/pavitra-programmers/openeral/sandbox:just-bash \
  --upload "$OPENERAL_INPUT:/sandbox/openeral-input" \
  --provider openclaw --auto-providers \
  -- openeral

rm -rf "$OPENERAL_INPUT"
```

`setup.sh` reads `/sandbox/openeral-input/anthropic-api-key`, writes it into `~/.openclaw/openclaw.json`, starts the openclaw gateway on `ws://127.0.0.1:18789`, waits for `/readyz`, then launches the OpenClaw TUI. Reuse `--name openeral-openclaw` on every machine and point it at the same `DATABASE_URL` so the PostgreSQL-backed home restores after deletion or on another host.

> **If Claude Code launches instead of OpenClaw**, the `openclaw` provider was not created or was not passed. Run the `openshell provider create` command above (one-time) and ensure you pass `--provider openclaw` in the sandbox create command.

> **Note:** StringCost cost tracking is supported for Claude Code only. OpenClaw talks to the Anthropic API directly using `ANTHROPIC_API_KEY`.

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

**OpenClaw hangs at `noodling…` and never responds** — the API key was not delivered to OpenClaw. The `openclaw` provider credential arrives as an opaque placeholder that OpenClaw cannot use directly. You must upload the real key as a file: include `anthropic-api-key` in the `openeral-input` directory as shown in [Start OpenClaw](#start-openclaw).

**OpenClaw shows `Gateway: not reachable at ws://127.0.0.1:18789`** — the openclaw gateway failed to start before the TUI launched. Check `/tmp/openclaw-gateway.log` inside the sandbox (`openshell sandbox connect <name>` then `cat /tmp/openclaw-gateway.log`). The gateway stages 35 npm packages on first cold start and can take a few minutes; setup waits up to 10 minutes before giving up.

**`setup.sh: error: DATABASE_URL is required.`** — no PostgreSQL connection string was uploaded. OpenEral has no embedded fallback. Pass `--upload /tmp/openeral-db-url:/sandbox/db-url` (or place `db-url` inside `/sandbox/openeral-input/` for OpenClaw) as shown in [Start Claude Code](#start-claude-code) or [Start OpenClaw](#start-openclaw).

**Migration fails with `tunnel to ... denied - 403`** - the PostgreSQL host is not allowlisted in the image policy. Common Supabase pooler hosts are included. Other hosts require a custom image; see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

**Migration fails with `EAI_AGAIN` or a placeholder-looking database URL** - do not use a generic `db` provider for PostgreSQL. Upload the connection string file with `--upload /tmp/openeral-db-url:/sandbox/db-url`.

## Contributing

Architecture, image customization, source-development workflows, and tests are documented in [BUILD.md](./BUILD.md).
