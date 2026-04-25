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
export OPENERAL_WORKSPACE=openeral-demo

openshell gateway start

openshell sandbox create \
  --name "$OPENERAL_WORKSPACE" \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- env WORKSPACE_ID="$OPENERAL_WORKSPACE" openeral-start

openshell sandbox connect "$OPENERAL_WORKSPACE"
```

Inside the connected sandbox shell, start Claude:

```bash
claude
```

Stop Claude and return to the sandbox shell:

```text
/exit
```

`Ctrl+D` also exits Claude Code. After Claude exits, the OpenEral sandbox stays alive, so you can run shell commands:

```bash
pg "SELECT now()"
openeral memory refresh --query "current project"
ls
```

Restart Claude from the same shell:

```bash
claude
```

Continue the most recent conversation:

```bash
claude -c
```

Leave the shell without deleting the sandbox:

```bash
exit
```

Reconnect later and restart Claude:

```bash
openshell sandbox connect "$OPENERAL_WORKSPACE"
claude -c
```

When you are completely done with the sandbox:

```bash
openshell sandbox delete "$OPENERAL_WORKSPACE"
```

The first Claude Code launch may ask you to choose a theme, accept the security notice, trust `/sandbox`, and confirm API usage billing. After that, Claude opens with `HOME=/home/agent` inside the sandbox.

Without PostgreSQL, OpenEral uses embedded PGlite under `/var/lib/openeral/data`. That state lives for the running sandbox lifetime and is removed when you delete the sandbox.

## Add PostgreSQL Persistence

Use this when you want files and Claude memory to survive sandbox deletion or follow you across machines.

For Supabase, use the pooler connection string from **Project Settings -> Database -> Connection pooler**. It looks like:

```text
postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Run:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://...'
export OPENERAL_WORKSPACE=openeral-demo

# Compatibility with .env files that use POSTGRES_URL.
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"

printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell sandbox create \
  --name "$OPENERAL_WORKSPACE" \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- env WORKSPACE_ID="$OPENERAL_WORKSPACE" openeral-start

rm -f /tmp/openeral-db-url

openshell sandbox connect "$OPENERAL_WORKSPACE"
claude
```

For PostgreSQL-only launches, OpenEral reads `/sandbox/db-url`, creates the `_openeral` schema, runs migrations, and seeds the workspace. In service mode it syncs Claude state under `/home/agent/.claude/**` and OpenEral state under `/home/agent/.openeral/**`; arbitrary checked-out source code remains sandbox-local. In Supabase, switch the Table Editor schema selector to `_openeral` to inspect the rows.

Do not pass the database URL through an OpenShell generic provider. PostgreSQL is raw TCP, so the credential must be delivered by `--upload`.

## Add StringCost Tracking

StringCost is optional. It routes Claude API calls through a presigned proxy URL for token and cost metering.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'
export OPENERAL_WORKSPACE=openeral-demo

OPENERAL_INPUT="$(mktemp -d)"
cleanup_openeral_input() { rm -rf "$OPENERAL_INPUT"; }
trap cleanup_openeral_input EXIT

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

openshell sandbox create \
  --name "$OPENERAL_WORKSPACE" \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload "$OPENERAL_INPUT:/sandbox/openeral-input" \
  --provider claude --provider stringcost --auto-providers \
  -- env WORKSPACE_ID="$OPENERAL_WORKSPACE" openeral-start

cleanup_openeral_input
trap - EXIT

openshell sandbox connect "$OPENERAL_WORKSPACE"
claude
```

Create the presign on the host. Inside OpenShell, provider secrets are placeholders; they work for HTTP headers but not as JSON body values for StringCost's `client_api_key`.

When using PostgreSQL and StringCost together, put both `db-url` and `presign.json` in the same `$OPENERAL_INPUT` directory and upload it to `/sandbox/openeral-input` as shown above. OpenShell accepts only one `--upload` flag.

## Manage Sandboxes

```bash
openshell sandbox list
openshell sandbox connect <name>
openshell sandbox exec -n <name> -- pg "SELECT 1"
openshell sandbox delete <name>
```

Run one-off commands with `sandbox exec`:

```bash
openshell sandbox exec -n <name> -- pg "SELECT 1"

openshell sandbox exec -n <name> -- \
  openeral memory refresh --query "current project"
```

Use `openshell sandbox connect <name>` for interactive Claude sessions. Use `openshell sandbox exec` for non-interactive checks and maintenance commands.

## Troubleshooting

**No active gateway** - run `openshell gateway start`.

**Claude exits with `Input must be provided either through stdin or as a prompt argument`** - start interactive Claude from `openshell sandbox connect <name>`. For non-interactive use, run `openshell sandbox exec -n <name> -- claude -p "your prompt"`.

**Claude says authentication failed** - set `ANTHROPIC_API_KEY` in the same shell that runs `openshell sandbox create`.

**Claude says credit balance is too low** - the Anthropic account for that key needs credits or billing enabled.

**Files disappear after `sandbox delete`** - PostgreSQL persistence was not enabled, or the recreated sandbox used a different `WORKSPACE_ID`. Use the PostgreSQL upload flow above and keep the same `WORKSPACE_ID` when recreating.

**Migration fails with `tunnel to ... denied - 403`** - the PostgreSQL host is not allowlisted in the image policy. Common Supabase pooler hosts are included. Other hosts require a custom image; see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

**Migration fails with `EAI_AGAIN` or a placeholder-looking database URL** - do not use a generic `db` provider for PostgreSQL. Upload the connection string file as `/sandbox/db-url`, or as `/sandbox/openeral-input/db-url` when also using StringCost.

## Contributing

Architecture, image customization, source-development workflows, and tests are documented in [BUILD.md](./BUILD.md).
