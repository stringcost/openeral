# OpenEral

Run Claude Code in an isolated sandbox — one command, no local build.

All commands use the published image `ghcr.io/sandys/openeral/sandbox:just-bash`. If you want to build from source, run the test suite, or understand the internals, see [BUILD.md](./BUILD.md).

---

## Prerequisites

- Docker running locally
- [`openshell` CLI](https://github.com/NVIDIA/OpenShell-Community)
- Anthropic API key (`sk-ant-…`)

---

## 1. Run it

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
openshell gateway start
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- openeral
```

Claude Code launches inside a sandbox with its own `$HOME`. Files stay there for the sandbox's lifetime — delete the sandbox and they're gone.

That's the whole happy path. The next two sections are opt-in upgrades.

---

## 2. Keep your work across sandboxes

Point openeral at any PostgreSQL and your workspace is persisted outside the sandbox. Next time you launch — same machine or another — it picks up where you left off.

Grab a connection string from **Supabase Dashboard → Project Settings → Database → Connection pooler** (either `5432` or `6543`), then:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
DB_URL='postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres'

printf '%s' "$DB_URL" > /tmp/db-url && chmod 600 /tmp/db-url

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/db-url \
  --provider claude --auto-providers \
  -- openeral
```

One new flag: `--upload /tmp/db-url`. On first launch openeral creates the `_openeral` schema and seeds your workspace; every future sandbox that uploads the same file sees the same data.

> The Supabase Table Editor shows `public` by default — switch the schema selector to `_openeral` to see your workspace rows.

Neon, RDS, or self-hosted PostgreSQL works the same. The shipped image allowlists common Supabase pooler regions; other hosts need a quick rebuild — see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

---

## 3. Track API cost

Route Claude's traffic through [StringCost](https://stringcost.com) for per-session token and cost metering.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'

openshell provider create --name stringcost --type generic \
  --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY"

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --provider stringcost --auto-providers \
  -- openeral
```

On first launch openeral creates a permanent presign and stores it in the workspace. Every subsequent launch reuses it.

---

## Managing a running sandbox

```bash
openshell sandbox list                            # what's running
openshell sandbox connect <name>                  # interactive shell
openshell sandbox delete <name>                   # stop and remove
```

Run a one-off command (e.g. refresh Claude's memory files from the workspace):

```bash
openshell sandbox ssh-config <name> > /tmp/sb-cfg
ssh -F /tmp/sb-cfg openshell-<name> \
  'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh'
```

The `HOME=/home/agent` prefix is required — SSH drops you into the base image's `/sandbox`, but openeral's state lives in `/home/agent`.

---

## Troubleshooting

**"No active gateway"** — run `openshell gateway start` first.

**Claude exits with "authentication failed"** — set `ANTHROPIC_API_KEY` in the shell you run `openshell sandbox create` in; the key must start with `sk-ant-`.

**Files gone after `sandbox delete`** — step 2 (`--upload /tmp/db-url`) wasn't used, so state lived in the sandbox's embedded PGlite.

**Migration fails with `tunnel to ... denied — 403`** — your Supabase pooler host isn't in the image's allowlist; see [BUILD.md](./BUILD.md#custom-postgresql-hosts).

**Migration fails with `EAI_AGAIN`** — you tried `--provider db --credential DATABASE_URL=…` instead of `--upload /tmp/db-url`. Raw-TCP credentials have to come through the upload path.

---

## Under the hood & contributing

Architecture, sandbox internals (HTTP CONNECT tunneling, credential injection, allowlist rebuild), local dev, and the test suite → [BUILD.md](./BUILD.md).
