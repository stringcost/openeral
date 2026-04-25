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

openshell sandbox create \
  --name openeral-demo \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --provider claude --auto-providers \
  -- env WORKSPACE_ID=openeral-demo openeral-start

openshell sandbox connect openeral-demo
claude
```

## Launch With PostgreSQL Persistence

PostgreSQL credentials must be uploaded as a plaintext file. Do not use a generic OpenShell provider for `DATABASE_URL`; provider placeholders are for HTTP credential injection and are not usable by raw PostgreSQL clients.

```bash
printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
chmod 600 /tmp/openeral-db-url

openshell sandbox create \
  --name openeral-demo \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  --upload /tmp/openeral-db-url:/sandbox/db-url \
  --provider claude --auto-providers \
  -- env WORKSPACE_ID=openeral-demo openeral-start

rm -f /tmp/openeral-db-url

openshell sandbox connect openeral-demo
claude
```

## What `setup.sh` Does

1. Resolves persistence from `DATABASE_URL`, `OPENERAL_DATABASE_URL`, `POSTGRES_URL`, or uploaded `/sandbox/db-url`.
2. Creates a normalized StringCost proxy config when `STRINGCOST_API_KEY` is attached.
3. Runs `_openeral` schema migrations.
4. Seeds the workspace keyed by explicit `$WORKSPACE_ID` or `$OPENSHELL_SANDBOX_ID`.
5. Starts the `openeral-bash` daemon.
6. In `openeral-start` mode, keeps the sandbox alive so users can connect and run `claude`, stop with `/exit` or `Ctrl+D`, then restart with `claude` or `claude -c`.
7. In legacy `openeral` mode, launches Claude Code immediately.

## Image Contents

- Node.js 22 LTS.
- OpenEral compiled into `/opt/openeral/dist/`.
- `openeral-bash.mjs`, the daemon/client bridge for `pg`, custom agents, and service-mode scoped sync.
- `setup.sh`, the sandbox entry point used by `openeral` and `openeral-start`.
- `openeral-claude.sh`, the Claude wrapper that applies the OpenEral session environment.
- `pg-client.mjs`, the `pg` helper for real-bash Claude sessions.
- `policy.yaml`, the OpenShell network policy at `/etc/openshell/policy.yaml`.
