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

## Persistence within a sandbox

By default, every sandbox starts with a fresh embedded PostgreSQL (PGlite). Files Claude writes under `$HOME` are persisted by openeral's sync layer into that PGlite database for the duration of the sandbox — so within a single sandbox lifetime, workspace state is durable across restarts, crashes, and reconnects (`openshell sandbox connect`).

If you delete the sandbox, the workspace is gone with it. There is no "bring-your-own PostgreSQL to persist across sandboxes" flow today — see the limitation note below.

### About external PostgreSQL (Supabase, Neon, RDS, …)

We verified end-to-end that external PostgreSQL from inside an OpenShell sandbox is **not currently reachable** with the upstream OpenShell networking model:

- The sandbox has a single egress route to `10.200.0.1:3128`, an **HTTP CONNECT** proxy. Raw-TCP clients (the PostgreSQL wire protocol) cannot speak HTTP CONNECT, so they have no route out.
- DNS resolution inside the sandbox is scoped to cluster services. External hostnames never resolve for raw-TCP callers.
- L4 policy entries in `policy.yaml` (endpoints without `protocol: rest`) apply to the HTTP proxy's CONNECT tunnels — they don't open a raw-socket bypass.

Claude Code itself works because its API calls are HTTPS and it honours `HTTPS_PROXY`. PostgreSQL cannot use that path.

Upstream OpenShell would need to add SOCKS5 / transparent TCP redirection, or an application-specific SQL proxy, before DATABASE_URL persistence can work. Track that at https://github.com/NVIDIA/OpenShell.

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

The presign is stored inside the sandbox workspace (embedded PGlite) and reused as long as that sandbox lives. Delete the sandbox and the stored presign goes with it.

---

## What you get

- **Isolated home** — Claude Code runs in its own `$HOME`, separate from your system
- **Embedded database** — PGlite runs in-process; workspace state is persisted within a sandbox's lifetime, no PostgreSQL setup required
- **Cost tracking** (with `STRINGCOST_API_KEY`) — automatic API cost metering per session
- **Memory refresh** — rewrites Claude's native project memory files based on your workspace content
- **Credential injection** — API keys stay as placeholders in the sandbox; the OpenShell HTTP proxy resolves them at egress
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

# query the embedded PGlite workspace database
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

You can set them per-invocation (`ANTHROPIC_API_KEY=... openshell sandbox create ...`) or in your shell profile.

External `DATABASE_URL` is intentionally omitted — see the "External PostgreSQL" note above for the architectural reason.

---

## How it works

```
  ┌─────────────────────── Sandbox ────────────────────────┐
  │  $HOME = isolated workspace                              │
  │  Claude Code (Read, Write, Edit, Bash, Glob, Grep)       │
  │                      │                                   │
  │                 file watcher                             │
  │                      │                                   │
  │  ┌───────────────────▼────────────────────────────────┐ │
  │  │  Embedded PGlite (stored inside the sandbox)       │ │
  │  └────────────────────────────────────────────────────┘ │
  └─────────────────────────┬──────────────────────────────┘
                            │ (HTTP-only via OpenShell proxy)
             ┌──────────────┴─────────────┐
             ▼                            ▼
      api.anthropic.com              StringCost
      (credential injection           (optional cost
       via x-api-key placeholder)      tracking proxy)
```

On startup, the sandbox restores the workspace from PGlite into a real directory. Claude Code runs normally; all its tools work on real files. A background watcher syncs changes back to PGlite. On exit, a final sync saves everything. The sandbox's only outbound route is the OpenShell HTTP proxy — HTTPS APIs work through it; raw-TCP clients (PostgreSQL, MySQL, Redis) do not.

---

## Troubleshooting

**`openshell gateway start` fails**
: Make sure Docker is running and the default gateway port is free.

**"No active gateway"** when running `openshell sandbox create`
: Run `openshell gateway start` first.

**Claude Code reports "authentication failed"**
: `export ANTHROPIC_API_KEY=...` in the shell where you run `openshell sandbox create`, and confirm `--provider claude --auto-providers` is on the command. Verify the key starts with `sk-ant-`.

**Files disappear after deleting the sandbox**
: Expected. The embedded PGlite lives inside the sandbox. Cross-sandbox persistence via an external PostgreSQL is not currently supported — see the "External PostgreSQL" note in the persistence section.

---

## Contributing / local development

Everything in this README uses the published GHCR image. If you want to build a local sandbox image from source, run the `openeral-js` CLI outside the sandbox, run the unit / integration / E2E tests, or modify the Dockerfile, policy, or setup script, see [BUILD.md](./BUILD.md).
