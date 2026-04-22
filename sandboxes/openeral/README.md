# OpenEral Sandbox Image

This directory contains the OpenShell sandbox image used by the end-user command in the repository README.

Published image:

```text
ghcr.io/sandys/openeral/sandbox:just-bash
```

## Build Locally

```bash
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:local .
```

## Launch From The Published Image

```bash
openshell gateway start

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- openeral
```

## Launch With PostgreSQL Persistence

PostgreSQL credentials must be uploaded as a plaintext file. Do not use a generic OpenShell provider for `DATABASE_URL`; provider placeholders are for HTTP credential injection and are not usable by raw PostgreSQL clients.

```bash
printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- openeral

rm -f /tmp/openeral-db-url
```

## What `setup.sh` Does

1. Resolves persistence from `DATABASE_URL`, `OPENERAL_DATABASE_URL`, `POSTGRES_URL`, or uploaded `/sandbox/db-url`.
2. Creates a normalized StringCost proxy config when `STRINGCOST_API_KEY` is attached.
3. Runs `_openeral` schema migrations.
4. Seeds the workspace keyed by `$OPENSHELL_SANDBOX_ID`.
5. Starts the `openeral-bash` daemon.
6. Launches Claude Code with `HOME=/home/agent` and `SHELL=/usr/local/bin/openeral-bash`.

## Image Contents

- Node.js 22 LTS.
- OpenEral compiled into `/opt/openeral/dist/`.
- `openeral-bash.mjs`, the daemon/client bridge for Claude Code's bash tool.
- `setup.sh`, the sandbox entry point.
- `policy.yaml`, the OpenShell network policy at `/etc/openshell/policy.yaml`.
