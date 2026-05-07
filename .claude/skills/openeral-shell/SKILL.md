---
name: openeral-shell
description: Run Claude Code in the published openeral OpenShell Docker-driver sandbox with persistent PostgreSQL-backed HOME at /home/agent
---

# OpenEral Shell

Use this when the goal is to run Claude Code with persistent state.

Assume:

- Claude must run with `HOME=/home/agent`
- `/home/agent` is durable
- `/db` is read-only context
- `/sandbox` is not durable
- `OPENERAL_DATABASE_URL` is exported on the host
- `ANTHROPIC_API_KEY` is exported on the host
- optional `SOCKET_TOKEN`, `STRINGCOST_API_KEY`, and `OPENERAL_AGENT=openclaw`
  providers can be added without changing the user flow

## Fresh Machine Flow

The runtime uses the upstream `openshell` CLI plus openeral images:

- `ghcr.io/sandys/openeral/gateway:latest`
- `ghcr.io/sandys/openeral/supervisor:latest`
- `ghcr.io/sandys/openeral/sandbox:latest`

The upstream CLI must match the gateway image protocol. Start by checking:

```bash
openshell --version
test -e /dev/fuse
```

For the current Docker-driver image set, upstream release CLI `0.0.36` is a
known-bad pairing because it uses the pre-`ObjectMeta` protobuf layout. Use a
matching upstream OpenShell CLI built from the same source/API version as the
gateway image until NVIDIA publishes a compatible release.

If provider or sandbox commands fail with protobuf decode errors, fix the
OpenShell CLI/gateway version pairing. Do not switch to a wrapper script for
the user flow.

Start the gateway as a Docker-driver gateway container, then register it:

```bash
export OPENERAL_GATEWAY_IMAGE=ghcr.io/sandys/openeral/gateway:latest
export OPENERAL_SUPERVISOR_IMAGE=ghcr.io/sandys/openeral/supervisor:latest
export OPENERAL_SANDBOX_IMAGE=ghcr.io/sandys/openeral/sandbox:latest

export OPENERAL_GATEWAY_NAME="${OPENERAL_GATEWAY_NAME:-openeral}"
export OPENERAL_GATEWAY_PORT="${OPENERAL_GATEWAY_PORT:-8080}"
export OPENERAL_GATEWAY_STATE="${OPENERAL_GATEWAY_STATE:-$HOME/.local/share/openeral-gateway}"

mkdir -p "$OPENERAL_GATEWAY_STATE/home"
docker rm -f openeral-gateway >/dev/null 2>&1 || true

docker run -d --name openeral-gateway --network host \
  --user "$(id -u):$(id -g)" \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$OPENERAL_GATEWAY_STATE:$OPENERAL_GATEWAY_STATE" \
  -e HOME="$OPENERAL_GATEWAY_STATE/home" \
  -e XDG_DATA_HOME="$OPENERAL_GATEWAY_STATE" \
  -e OPENSHELL_BIND_ADDRESS=0.0.0.0 \
  -e OPENSHELL_SERVER_PORT="$OPENERAL_GATEWAY_PORT" \
  -e OPENSHELL_DB_URL="sqlite:${OPENERAL_GATEWAY_STATE}/openshell.db" \
  -e OPENSHELL_DRIVERS=docker \
  -e OPENSHELL_DISABLE_TLS=true \
  -e OPENSHELL_GRPC_ENDPOINT="http://127.0.0.1:${OPENERAL_GATEWAY_PORT}" \
  -e OPENSHELL_DOCKER_SUPERVISOR_IMAGE="$OPENERAL_SUPERVISOR_IMAGE" \
  -e OPENSHELL_DOCKER_FUSE_DEVICE=/dev/fuse \
  -e OPENSHELL_SANDBOX_IMAGE="$OPENERAL_SANDBOX_IMAGE" \
  "$OPENERAL_GATEWAY_IMAGE" \
  --bind-address 0.0.0.0 \
  --port "$OPENERAL_GATEWAY_PORT"

openshell gateway add --local --name "$OPENERAL_GATEWAY_NAME" "http://127.0.0.1:${OPENERAL_GATEWAY_PORT}"
openshell gateway select "$OPENERAL_GATEWAY_NAME"
```

Create providers:

```bash
DATABASE_URL="$OPENERAL_DATABASE_URL" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name db \
  --type generic \
  --credential DATABASE_URL

ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name claude \
  --type generic \
  --credential ANTHROPIC_API_KEY
```

Use `--credential NAME`, not `--credential NAME=value`. The former reads the
secret from the host environment and avoids putting secrets in argv/history.
Do not upload `DATABASE_URL` or API keys into the sandbox.

Optional providers:

```bash
SOCKET_TOKEN="$SOCKET_TOKEN" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name socket \
  --type generic \
  --credential SOCKET_TOKEN

STRINGCOST_API_KEY="$STRINGCOST_API_KEY" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name stringcost \
  --type generic \
  --credential STRINGCOST_API_KEY

OPENERAL_AGENT=openclaw openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name openclaw \
  --type generic \
  --credential OPENERAL_AGENT
```

Launch Claude:

```bash
export OPENERAL_SANDBOX_NAME="${OPENERAL_SANDBOX_NAME:-claude-openeral}"

openshell sandbox create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name "$OPENERAL_SANDBOX_NAME" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider db \
  --provider claude \
  --auto-providers \
  --no-tty -- env HOME=/home/agent claude
```

The sandbox bootstrap runs automatically after FUSE mounts are ready. It seeds
`.claude`, configures optional Socket.dev and StringCost settings, and keeps
real provider secrets out of the child process.

If optional providers were not created, omit their `--provider` flags. Keep the
flow as composed `openshell` commands; do not use sandbox upload or wrapper
scripts to inject database credentials.

Launch OpenClaw with the same command-composed pattern:

```bash
openshell sandbox create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name "${OPENERAL_SANDBOX_NAME}-openclaw" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider db \
  --provider claude \
  --provider openclaw \
  --auto-providers \
  --no-tty -- env HOME=/home/agent openclaw
```

## Health Checks

Inside the sandbox:

```bash
test -e /dev/fuse
grep -E ' /db | /home/agent ' /proc/mounts
test -w /home/agent
test -f /home/agent/.claude/settings.json
```

Non-interactive Claude check:

```bash
HOME=/home/agent claude -p 'Reply with READY and nothing else.'
```

Expected persistent paths:

- `/home/agent/.claude.json`
- `/home/agent/.claude/settings.json`
- `/home/agent/.claude/projects/...`

If state disappears, debug `HOME` and the `/home/agent` mount first.

Refresh persisted Claude memory files inside the sandbox:

```bash
openeral memory refresh --project-root /sandbox/project
```
