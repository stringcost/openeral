# OpenEral

Run Claude Code inside an isolated OpenShell sandbox using the published image:

```text
ghcr.io/sandys/openeral/sandbox:just-bash
```

No local source checkout or JavaScript toolchain is required for the normal user flow. Contributor workflows live in [BUILD.md](./BUILD.md).

## Prerequisites

- Docker is running.
- The [`openshell` CLI](https://github.com/NVIDIA/OpenShell-Community) is installed.
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

Use this when you want files and Claude memory to survive sandbox deletion or follow you across machines.

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
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- openeral

rm -f /tmp/openeral-db-url
```

OpenEral reads `/sandbox/db-url`, creates the `_openeral` schema, runs migrations, and seeds the workspace. In Supabase, switch the Table Editor schema selector to `_openeral` to inspect the rows.

Do not pass the database URL through an OpenShell generic provider. PostgreSQL is raw TCP, so the credential must be delivered by `--upload`.

## Add StringCost Tracking

StringCost is optional. It routes Claude API calls through a presigned proxy URL for token and cost metering.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'

openshell provider create --name stringcost --type generic \
  --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY" \
  || openshell provider update stringcost \
    --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY"

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --provider stringcost --auto-providers \
  -- openeral
```

On first launch, OpenEral creates a permanent StringCost presign and stores it under `/home/agent/.openeral/presign.json`. Later launches reuse it.

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

**No active gateway** - run `openshell gateway start`.

**Claude exits with `Input must be provided either through stdin or as a prompt argument`** - the command was run without an interactive terminal. Use a real terminal and keep `--tty` in the command.

**Claude says authentication failed** - set `ANTHROPIC_API_KEY` in the same shell that runs `openshell sandbox create`.

**Claude says credit balance is too low** - the Anthropic account for that key needs credits or billing enabled.

**Files disappear after `sandbox delete`** - PostgreSQL persistence was not enabled. Use the `/sandbox/db-url` upload flow above.

**Migration fails with `tunnel to ... denied - 403`** - the PostgreSQL host is not allowlisted in the image policy. Common Supabase pooler hosts are included. Other hosts require a custom image; see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

**Migration fails with `EAI_AGAIN` or a placeholder-looking database URL** - do not use a generic `db` provider for PostgreSQL. Upload the connection string file with `--upload /tmp/openeral-db-url:/sandbox/db-url`.

## Contributing

Architecture, image customization, source-development workflows, and tests are documented in [BUILD.md](./BUILD.md).
