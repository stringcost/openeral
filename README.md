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
  -- openeral
```

`--auto-providers` reads `ANTHROPIC_API_KEY` from your local environment, creates an OpenShell `claude` provider, and attaches it to the sandbox. Claude Code launches inside with an isolated `$HOME`. Files you create are kept inside the workspace for the duration of the sandbox. No local database required — OpenEral uses an embedded PGlite inside the sandbox.

---

## Persistence across sandboxes (Supabase or any PostgreSQL)

openeral persists the workspace to an external PostgreSQL so state survives `openshell sandbox delete` and is shared across machines that point at the same database. The natural choice is Supabase — copy the connection string from Supabase dashboard → Project Settings → Database → **Connection pooler**. Either port works (`5432` = session, `6543` = transaction). The direct `db.<project>.supabase.co` endpoint is IPv6-only and not recommended; use the pooler.

OpenShell's sandbox network only allows egress through an HTTP CONNECT proxy — raw-TCP PostgreSQL clients cannot dial the host themselves. openeral-js handles this by wrapping pg's socket with a CONNECT handshake, so the OpenShell proxy sees a normal `CONNECT pooler.supabase.com:5432` from `/usr/bin/node`, allows it per `policy.yaml`, and relays the tunnel bytes end-to-end. pg negotiates its own TLS with Supabase inside that tunnel.

Delivering the URL as plaintext is the other half: OpenShell providers wrap every credential as an `openshell:resolve:env:*` placeholder that only HTTP L7 inspection can resolve, which pg can't use. The supported plaintext channel is `openshell sandbox create --upload`:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
DB_URL='postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres'

# Drop the URL into a local file — plaintext, permissions 600
printf '%s' "$DB_URL" > /tmp/db-url && chmod 600 /tmp/db-url

openshell gateway info >/dev/null 2>&1 || openshell gateway start
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/db-url \
  --provider claude --auto-providers \
  -- openeral
```

`setup.sh` reads `/sandbox/db-url` on startup, exports `DATABASE_URL`, and migrations + the workspace sync layer all go through the CONNECT-tunnelled pg connection. Claude inside the sandbox can also run `pg "SELECT ..."` directly.

**Pre-allowlisted hosts.** The shipped `policy.yaml` covers the common Supabase pooler regions (`aws-0-us-east-1`, `aws-0-us-west-1`, `aws-0-eu-west-1`, `aws-0-eu-central-1`, `aws-1-ap-northeast-1`, `aws-0-ap-south-1`, and a handful more). If your pooler host isn't listed, rebuild the image with your host appended to the `postgres` network policy — see [BUILD.md](./BUILD.md).

**Non-Supabase PostgreSQL.** Any publicly-reachable PostgreSQL works the same way (Neon, RDS, self-hosted). Add the host to `policy.yaml` and rebuild.

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
  -- openeral
```

`setup.sh` inside the sandbox creates a permanent StringCost presign (never expires, unlimited uses) on first launch, stores it inside the workspace, and reuses it on every subsequent launch. Claude's traffic then routes through the presign URL automatically.

The presign is stored inside the sandbox workspace (embedded PGlite) and reused as long as that sandbox lives. Delete the sandbox and the stored presign goes with it.

---

## What you get

- **Isolated home** — Claude Code runs in its own `$HOME`, separate from your system
- **Embedded database** (default) — PGlite runs in-process; workspace state is persisted for the sandbox's lifetime, no PostgreSQL setup required
- **Cross-sandbox persistence** (with `--upload /tmp/db-url`) — pg tunnels through the OpenShell HTTP CONNECT proxy to an external Supabase / Neon / RDS; workspace survives `openshell sandbox delete` and is shared across machines
- **Database access** (with `--upload /tmp/db-url`) — `pg "SELECT * FROM users LIMIT 5"` from Claude's bash
- **Cost tracking** (with `STRINGCOST_API_KEY`) — automatic API cost metering per session
- **Memory refresh** — rewrites Claude's native project memory files based on your workspace content
- **Credential injection** — HTTP API keys stay as placeholders in the sandbox; the OpenShell HTTP proxy resolves them at egress
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

# query the workspace database
ssh -F /tmp/sb-cfg openshell-<name> 'HOME=/home/agent pg "SELECT now()"'
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
| `STRINGCOST_API_KEY` | optional | StringCost API key. Enables cost tracking via the `stringcost` provider. |
| `DATABASE_URL` (via `--upload`) | optional | PostgreSQL connection string delivered as a plaintext file (`openshell sandbox create --upload /tmp/db-url`). Enables cross-sandbox persistence and the `pg` command. The provider framework cannot carry this — see the persistence section. |

You can set `ANTHROPIC_API_KEY` / `STRINGCOST_API_KEY` per-invocation (`ANTHROPIC_API_KEY=... openshell sandbox create ...`) or in your shell profile.

---

## How it works

```
  ┌─────────────────────── Sandbox ─────────────────────────┐
  │  $HOME = isolated workspace                                │
  │  Claude Code (Read, Write, Edit, Bash, Glob, Grep)         │
  │                      │                                     │
  │                 file watcher                               │
  │                      │                                     │
  │  openeral-js sync ───▼──────────────────────────────────┐  │
  │  PGlite (default)  OR  pg.Pool with CONNECT-tunneled    │  │
  │                         socket (when --upload db-url)   │  │
  │  ───────────────────────────────────────────────────────┘  │
  └────────────────────────┬───────────────────────────────────┘
                           │  (all egress via OpenShell HTTP CONNECT proxy)
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   api.anthropic.com   StringCost      Supabase pg wire protocol
   (x-api-key          (cost tracking  (CONNECT tunnel; pg negotiates
    placeholder         proxy)          its own TLS end-to-end)
    resolved at proxy)
```

Every outbound connection from the sandbox goes through OpenShell's HTTP CONNECT proxy at `10.200.0.1:3128`. HTTPS clients honour `HTTPS_PROXY` and flow through naturally. The pg driver doesn't speak CONNECT out of the box, so openeral-js gives it a custom socket factory (`src/db/http-connect-socket.ts`) that negotiates CONNECT first and then hands pg a tunneled `net.Socket`. The proxy sees the CONNECT from `/usr/bin/node`, checks the `postgres` network policy, and — if the host is allowlisted — relays the rest of the bytes unchanged to Supabase. pg's own TLS handshake runs end-to-end inside that tunnel, so credentials never reach the proxy.

---

## Troubleshooting

**`openshell gateway start` fails**
: Make sure Docker is running and the default gateway port is free.

**"No active gateway"** when running `openshell sandbox create`
: Run `openshell gateway start` first.

**Claude Code reports "authentication failed"**
: `export ANTHROPIC_API_KEY=...` in the shell where you run `openshell sandbox create`, and confirm `--provider claude --auto-providers` is on the command. Verify the key starts with `sk-ant-`.

**Files disappear after deleting the sandbox**
: You didn't pass `--upload /tmp/db-url`. Without it, workspace state lives in embedded PGlite inside the sandbox and goes away with it. See the persistence section for the Supabase upload flow.

**Migration fails with `tunnel to ... denied — HTTP/1.1 403 Forbidden`**
: The OpenShell proxy rejected the CONNECT because your Supabase pooler host is not in the image's `postgres` network policy. Check the host in your `DATABASE_URL` and rebuild the image with that host added (see BUILD.md) — or use a Supabase region that's already allowlisted.

**Migration fails with `EAI_AGAIN` or an unresolvable hostname**
: Your `DATABASE_URL` got injected as an OpenShell placeholder (`openshell:resolve:env:DATABASE_URL`) instead of the real URL — you used `--provider db --credential DATABASE_URL=...` instead of `--upload /tmp/db-url`. The provider framework wraps every credential as a placeholder that only HTTP L7 inspection can resolve; pg cannot use it. Switch to the `--upload` form shown in the persistence section.

---

## Contributing / local development

Everything in this README uses the published GHCR image. If you want to build a local sandbox image from source, run the `openeral-js` CLI outside the sandbox, run the unit / integration / E2E tests, or modify the Dockerfile, policy, or setup script, see [BUILD.md](./BUILD.md).
