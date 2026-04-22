# OpenEral Sandbox

OpenShell sandbox image for running Claude Code with persistent PostgreSQL-backed home directory.

Uses **stock OpenShell** — no custom cluster or gateway images needed.

## Build

```bash
docker build -f sandboxes/openeral/Dockerfile -t ghcr.io/sandys/openeral/sandbox:just-bash .
```

## Launch

```bash
openshell gateway start

openshell provider create \
  --name db --type generic --credential DATABASE_URL

openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider db --provider claude --auto-providers \
  -- openeral
```

## What setup.sh does

1. Runs `_openeral` schema migrations against `$DATABASE_URL` (injected by provider)
2. Seeds the workspace (keyed to `$OPENSHELL_SANDBOX_ID`)
3. Starts the `openeral-bash` daemon (just-bash shell on Unix socket)
4. Launches Claude Code with `HOME=/home/agent SHELL=/usr/local/bin/openeral-bash`

## Image contents

- Node.js 22 LTS (via NodeSource)
- openeral-js (compiled TypeScript at `/opt/openeral/dist/`)
- `openeral-bash.mjs` — daemon/client bridge for Claude Code's bash tool
- `setup.sh` — sandbox entry point
- `policy.yaml` — network policy at `/etc/openshell/policy.yaml`
