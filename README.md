# OpenEral

OpenEral exists to run Claude Code inside OpenShell with a persistent
PostgreSQL-backed home directory.

The supported outcome is:

- upstream `openshell` CLI is installed on the host
- an openeral Docker-driver gateway is running locally
- Claude Code starts inside an OpenShell sandbox
- `/home/agent` is mounted read-write through `openeral`
- Claude's `~/.claude` state persists in PostgreSQL
- `/db` is mounted read-only for database context

The OpenShell CLI is not forked. This repo ships runtime images and a patched
OpenShell gateway/supervisor pair.

## Image Contract

The Docker compute driver flow uses three version-locked images:

- `ghcr.io/sandys/openeral/gateway:latest`
- `ghcr.io/sandys/openeral/supervisor:latest`
- `ghcr.io/sandys/openeral/sandbox:latest`

What each image owns:

- `gateway` runs the patched OpenShell gateway with the Docker compute driver.
- `supervisor` contains the patched `openshell-sandbox` binary that reads
  `/etc/fstab` and starts the openeral FUSE mounts.
- `sandbox` contains Claude Code support, optional OpenClaw support,
  `openeral`, `fuse3`, `/etc/fstab`, and `/etc/openshell/policy.yaml`.

Do not mix openeral `gateway`, `supervisor`, or `sandbox` images with upstream
OpenShell runtime images. The upstream CLI is the only upstream component in the
supported user flow.

## OpenShell CLI Compatibility

The host CLI is upstream `openshell`, but it must speak the same protobuf API as
the openeral gateway image. The Docker-driver gateway currently tracks upstream
OpenShell `main`; released installers can lag that API.

Known-bad example: upstream release CLI `0.0.36` is not compatible with the
current Docker-driver gateway because it uses the pre-`ObjectMeta` protobuf
layout. Use an upstream OpenShell CLI built from the same upstream source
version as the openeral gateway image until NVIDIA publishes a matching release.

```bash
openshell --version
```

If provider or sandbox commands fail with protobuf decode errors, treat that as
a CLI/gateway version mismatch. Do not work around it by using repo-local wrapper
scripts. Install or build the matching upstream CLI, or use an openeral image
tag built from the upstream version already installed on the host.

## Fresh Machine Flow

Assume a fresh machine with:

- upstream `openshell` already installed from a source/API version matching the
  openeral gateway image
- Docker available on the host
- `/dev/fuse` available on the host
- a live PostgreSQL database already available
- host `ANTHROPIC_API_KEY` available

Set image refs and runtime values:

```bash
export OPENERAL_GATEWAY_IMAGE=ghcr.io/sandys/openeral/gateway:latest
export OPENERAL_SUPERVISOR_IMAGE=ghcr.io/sandys/openeral/supervisor:latest
export OPENERAL_SANDBOX_IMAGE=ghcr.io/sandys/openeral/sandbox:latest

export OPENERAL_GATEWAY_NAME=openeral
export OPENERAL_GATEWAY_PORT=8080
export OPENERAL_GATEWAY_STATE="$HOME/.local/share/openeral-gateway"
export OPENERAL_DATABASE_URL='postgresql://myuser:mypassword@pg.example.com/mydb'
export OPENERAL_SANDBOX_NAME=claude-openeral
```

`OPENERAL_DATABASE_URL` can be any PostgreSQL connection string accepted by
`tokio-postgres`. URI form is preferred in docs because it avoids shell parsing
ambiguity around spaces.

Start the Docker-driver gateway:

```bash
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
```

The explicit `--bind-address` and `--port` arguments are intentional. The
gateway image has an upstream default command that binds port `8080`; passing
these arguments makes `OPENERAL_GATEWAY_PORT` authoritative instead of relying
on image defaults.

Register it with the stock OpenShell CLI:

```bash
openshell gateway add --local \
  --name "$OPENERAL_GATEWAY_NAME" \
  "http://127.0.0.1:${OPENERAL_GATEWAY_PORT}"

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

Always pass provider secrets through the CLI's environment lookup form
`--credential NAME`. Do not put secret values directly in the command line with
`--credential NAME=value`; that leaks through shell history/process listings and
has produced brittle behavior across OpenShell CLI/gateway versions.

Do not upload `DATABASE_URL` into the sandbox. The supervisor receives the real
database provider value before child env is converted to placeholders, mounts
`/db` and `/home/agent`, and then starts the child with placeholder secrets.

Run Claude Code with a persistent home:

```bash
openshell sandbox create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name "$OPENERAL_SANDBOX_NAME" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider db \
  --provider claude \
  --provider socket \
  --provider stringcost \
  --auto-providers \
  --no-tty -- env HOME=/home/agent claude
```

Omit optional providers you do not use, and omit their matching `--provider`
flags. The sandbox bootstrap is image-owned and runs automatically after FUSE
mounts are ready; there is no `openeral` wrapper entrypoint in the user flow.

Run OpenClaw instead of Claude Code:

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

Non-interactive validation:

```bash
openshell sandbox create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name "${OPENERAL_SANDBOX_NAME}-check" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider db \
  --provider claude \
  --auto-providers \
  --no-tty -- env HOME=/home/agent claude -p 'Reply with READY and nothing else.'
```

## What To Verify

Inside a healthy sandbox:

```bash
test -e /dev/fuse
grep -E ' /db | /home/agent ' /proc/mounts
test -w /home/agent
env | grep '^ANTHROPIC_API_KEY='
```

Expected results:

- `/dev/fuse` exists because the Docker driver mapped the host FUSE device.
- `/home/agent` is writable and backed by PostgreSQL.
- `/db` is read-only database context.
- `ANTHROPIC_API_KEY` is a placeholder value in the child environment.
- `/home/agent/.claude/settings.json` is seeded automatically.

The sandbox policy at `/etc/openshell/policy.yaml` authorizes the Anthropic
REST path so the OpenShell proxy can rewrite the placeholder at egress. Real
secrets stay in provider env and are not handed to Claude Code directly.

## Persistence

Everything Claude needs to keep must live under `/home/agent`.

Important paths:

- `/home/agent/.claude.json`
- `/home/agent/.claude/settings.json`
- `/home/agent/.claude/projects/...`

Those files are stored in the backing database table
`_openeral.workspace_files`. `/sandbox` is not the durable home.

The FUSE workspace denies common credential and history paths instead of
persisting them, including `~/.ssh`, `~/.aws`, `~/.azure`, `~/.docker`,
`~/.gnupg`, `~/.kube`, `~/.npm`, `~/.npmrc`, shell history files, and
`~/.local/share/keyrings`.

Refresh Claude memory files inside a running sandbox:

```bash
openeral memory refresh --project-root /sandbox/project
```

The command writes under `/home/agent/.claude/projects/.../memory`, so the
result persists through the PostgreSQL-backed workspace mount.

## Local Development

Local development uses the same Docker compute driver flow. Build local image
tags, then run the same OpenShell commands with those tags.

The local dev flow still uses the upstream `openshell` CLI. When the latest
OpenShell release lags the vendored upstream source, build the matching CLI from
`vendor/openshell`; this is still the upstream OpenShell CLI source, not an
openeral wrapper.

```bash
cargo build --manifest-path vendor/openshell/Cargo.toml --release -p openshell-cli
export PATH="$PWD/vendor/openshell/target/release:$PATH"
openshell --version
```

Do not replace the documented flow with a custom CLI or wrapper script.

Build the openeral gateway and supervisor from vendored OpenShell:

```bash
docker build \
  -f vendor/openshell/deploy/docker/Dockerfile.images \
  --target gateway \
  --build-arg BUILD_FROM_SOURCE=1 \
  --build-arg OPENSHELL_IMAGE_TAG=dev \
  -t openeral/gateway:dev \
  vendor/openshell

docker build \
  -f vendor/openshell/deploy/docker/Dockerfile.images \
  --target supervisor \
  --build-arg BUILD_FROM_SOURCE=1 \
  --build-arg OPENSHELL_IMAGE_TAG=dev \
  -t openeral/supervisor:dev \
  vendor/openshell
```

Build the sandbox image:

```bash
docker build \
  -f sandboxes/openeral/Dockerfile \
  -t openeral/sandbox:dev \
  .
```

Use local tags:

```bash
export OPENERAL_GATEWAY_IMAGE=openeral/gateway:dev
export OPENERAL_SUPERVISOR_IMAGE=openeral/supervisor:dev
export OPENERAL_SANDBOX_IMAGE=openeral/sandbox:dev
```

Then run the Fresh Machine Flow above.

For CI-equivalent local validation, run the GitHub Actions workflow with `act`.
The workflow builds local images and runs the Docker-driver smoke test; GHCR
publish steps are skipped under `act`. This repository includes `.actrc` so
the job container has the FUSE privileges required by `tests/test_fuse_mount.sh`.

```bash
act push -W .github/workflows/publish-images.yml
```

## Development Checks

Use the product flow first:

```bash
bash .github/scripts/smoke_openshell.sh
```

The smoke script is verification automation. It is not the documented user
interface; user-facing instructions should remain composed `docker` and
`openshell` commands.

If a change touches `openeral` CLI subcommands, keep
`crates/openeral-core/src/cli/fuse_fd.rs` in sync. `mount.fuse3` invokes the
binary as `openeral <source> <mountpoint>`, so every real CLI subcommand must be
listed in `KNOWN_SUBCOMMANDS`; otherwise a command such as `openeral bootstrap`
can be misclassified as a FUSE mount source.

Lower-level checks:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
cargo test --manifest-path vendor/openshell/Cargo.toml \
  -p openshell-driver-docker \
  -p openshell-policy \
  -p openshell-sandbox
```

Live Claude and boundary secret-injection check, requiring
`ANTHROPIC_API_KEY` and network access:

```bash
bash tests/test_live_secret_injection.sh
```
