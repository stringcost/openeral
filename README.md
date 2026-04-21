# OpenEral

Run Claude Code in an isolated, persistent, cost-tracked sandbox — one command, no local build required.

All commands in this README use the **published Docker image** at `ghcr.io/sandys/openeral/sandbox:just-bash`. You do not need to clone this repository to use OpenEral. If you want to build locally or contribute, see [BUILD.md](./BUILD.md).

---

## Prerequisites

- **Docker** — running locally
- **openshell** CLI — install from https://github.com/NVIDIA/OpenShell-Community
- **Anthropic API key** — `sk-ant-…` from https://console.anthropic.com

---

## Quick start

```bash
# 1. Put your Anthropic key in the environment
export ANTHROPIC_API_KEY='sk-ant-...'

# 2. Start the OpenShell gateway (k3s cluster inside Docker)
openshell gateway start

# 3. Launch Claude Code in a sandbox from the published image
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- /opt/openeral/setup.sh
```

`--auto-providers` reads `ANTHROPIC_API_KEY` from your local environment, creates an OpenShell `claude` provider, and attaches it to the sandbox. Claude Code launches inside with an isolated `$HOME`. Files you create are kept inside the workspace for the duration of the sandbox. No local database required — OpenEral uses an embedded PGlite inside the sandbox.

---

## Persistence across launches (Supabase or any PostgreSQL)

By default, the sandbox workspace is recreated fresh on each launch. To make files survive, point OpenEral at any PostgreSQL database.

**Supabase** gives you a PostgreSQL connection string out of the box — copy it from Supabase dashboard → Project Settings → Database → Connection string (URI). Use the pooled (pgbouncer) connection on port `6543` or the direct connection on `5432` — whichever the dashboard gives you.

The database must be **reachable from inside the sandbox pod over the public internet** — a loopback or private-docker IP will not work. Use Supabase, Neon, RDS, or any host with a public DNS name.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export DATABASE_URL='postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres'

# Explicitly create the db provider with the connection string baked in.
# (--auto-providers only auto-creates providers whose name matches a known type —
# claude, openai, anthropic, etc. A "generic" provider like `db` must be created
# explicitly before sandbox create.)
openshell provider create --name db --type generic \
  --credential "DATABASE_URL=$DATABASE_URL"

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --provider db --auto-providers \
  -- /opt/openeral/setup.sh
```

With `DATABASE_URL` set and the `db` provider attached:
- Every file Claude writes under `$HOME` is synced to PostgreSQL.
- Launching again with the same database restores the workspace.
- Claude can query the database directly via `pg "SELECT ..."` inside its Bash tool.

Any PostgreSQL that accepts standard connections works — Supabase, Neon, RDS, or self-hosted. Paste the connection string **verbatim** from the provider dashboard; don't strip the port.

---

## Cost tracking with StringCost

Route Claude's API calls through [StringCost](https://stringcost.com) to track tokens and cost per session:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
export STRINGCOST_API_KEY='sk-st-...'

# Explicitly create the stringcost provider (same reason as `db` — `stringcost`
# is a generic provider type, not an auto-discoverable one)
openshell provider create --name stringcost --type generic \
  --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY"

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --provider stringcost --auto-providers \
  -- /opt/openeral/setup.sh
```

`setup.sh` inside the sandbox creates a permanent StringCost presign (never expires, unlimited uses) on first launch, stores it inside the workspace, and reuses it on every subsequent launch. Claude's traffic then routes through the presign URL automatically.

Combine with `--provider db` to make the presign itself persist across launches.

---

## What you get

- **Isolated home** — Claude Code runs in its own `$HOME`, separate from your system
- **Embedded database** — PGlite runs in-process; workspace state is persisted within a session, no PostgreSQL setup required
- **Cross-session persistence** (with `DATABASE_URL`) — files survive across launches
- **Database access** (with `DATABASE_URL`) — `pg "SELECT * FROM users LIMIT 5"` from Claude's bash
- **Cost tracking** (with `STRINGCOST_API_KEY`) — automatic API cost metering per session
- **Memory refresh** — rewrites Claude's native project memory files based on your workspace content
- **Credential injection** — API keys stay as placeholders in the sandbox; the OpenShell proxy resolves them at egress
- **Session isolation** — different sandbox = different workspace

---

## Managing the running sandbox

`openshell sandbox create` leaves Claude Code attached to your terminal. In another shell:

```bash
openshell sandbox list                            # list running sandboxes
openshell sandbox connect <name>                  # open an interactive shell inside
openshell sandbox delete <name>                   # stop and remove a sandbox
openshell sandbox ssh-config <name>               # print ssh config for scripted access
```

**Run a one-off command in a running sandbox** via the ssh-config helper:

```bash
openshell sandbox ssh-config <name> > /tmp/sb-cfg
ssh -F /tmp/sb-cfg openshell-<name> 'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh'

# focus the refresh on a specific topic
ssh -F /tmp/sb-cfg openshell-<name> 'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh --query "openshell policy"'

# query the workspace database (DATABASE_URL-configured sandboxes only)
ssh -F /tmp/sb-cfg openshell-<name> 'HOME=/home/agent pg "SELECT count(*) FROM public.users"'
```

The `HOME=/home/agent` prefix is required because SSH drops you into the default `/sandbox` home of the base image — openeral's workspace, memory files, and `.claude/` state all live under `/home/agent`.

---

## Writing files from Claude prompts

Claude's file tools do not always expand `$HOME` or `~` the way you expect. When a prompt needs to touch files in the isolated home, prefer `Run:` Bash commands:

```
Run: printf "%s" "hello" > "$HOME/notes.txt" && echo WRITTEN
Run: cat "$HOME/notes.txt"
```

`$HOME` inside the sandbox points at the isolated workspace root, not your laptop's home directory.

---

## Environment variables

OpenEral reads these from your local shell; `--auto-providers` makes them available inside the sandbox.

| Variable | Required? | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Authenticates Claude Code. Backs the `claude` provider. |
| `DATABASE_URL` | optional | PostgreSQL connection string. Backs the `db` provider. Enables cross-session persistence and the `pg` command. |
| `STRINGCOST_API_KEY` | optional | StringCost API key. Backs the `stringcost` provider. Enables cost tracking. |

You can set them per-invocation (`ANTHROPIC_API_KEY=... openshell sandbox create ...`) or in your shell profile.

---

## How it works

```
  ┌────────────────────── Sandbox ─────────────────────────┐
  │  $HOME = isolated workspace                              │
  │  Claude Code (Read, Write, Edit, Bash, Glob, Grep)       │
  │                      │                                   │
  │                 file watcher                             │
  │                      │                                   │
  │  ┌───────────────────▼────────────────────────────────┐ │
  │  │  PGlite (embedded) or external PostgreSQL          │ │
  │  └────────────────────────────────────────────────────┘ │
  └──────────────────────┬───────────────────────────────────┘
                         │
         ┌───────────────┼────────────────┐
         ▼               ▼                ▼
   api.anthropic.com  StringCost    Your PostgreSQL
   (via OpenShell    (cost proxy,  (Supabase, Neon, etc.)
    credential        optional)
    injection)
```

On startup, the sandbox restores the workspace from the database (PGlite or external PostgreSQL) into a real directory. Claude Code runs normally; all its tools work on real files. A background watcher syncs changes back to the database. On exit, a final sync saves everything.

---

## Troubleshooting

**`openshell gateway start` fails**
: Make sure Docker is running and the default gateway port is free.

**"No active gateway"** when running `openshell sandbox create`
: Run `openshell gateway start` first.

**Supabase connection fails / hangs**
: Paste the connection string **exactly** as Supabase shows it, port and all. Test it from your laptop first: `psql "$DATABASE_URL" -c 'select 1'`. If that fails, the string is wrong. Supabase gives two strings — pooled (port 6543) and direct (port 5432); either works.

**Claude Code reports "authentication failed"**
: `export ANTHROPIC_API_KEY=...` in the shell where you run `openshell sandbox create`, and confirm `--provider claude --auto-providers` is on the command. Verify the key starts with `sk-ant-`.

**Files aren't persisting across launches**
: Confirm `DATABASE_URL` was exported, `--provider db` was on the create command, and the startup log inside the sandbox shows `openeral: persist    PostgreSQL` (not `embedded PGlite`).

---

## Contributing / local development

Everything in this README uses the published GHCR image. If you want to build a local sandbox image from source, run the `openeral-js` CLI outside the sandbox, run the unit / integration / E2E tests, or modify the Dockerfile, policy, or setup script, see [BUILD.md](./BUILD.md).
