# OpenEral Sandbox

This image is the OpenShell sandbox runtime for Claude Code with a persistent
PostgreSQL-backed home at `/home/agent`.

It is not a standalone entrypoint image. OpenShell starts the patched
`openshell-sandbox` supervisor, and the supervisor mounts the FUSE filesystems
declared in this image's `/etc/fstab`.

## Runtime Contract

The supported flow uses:

- upstream `openshell` CLI on the host, built or installed from a source/API
  version matching the openeral gateway image
- openeral `gateway` image running the OpenShell Docker compute driver
- openeral `supervisor` image containing the patched supervisor binary
- this openeral `sandbox` image

Compatibility note: upstream release CLI `0.0.36` is a known-bad pairing for
the current Docker-driver gateway image because it uses the older
pre-`ObjectMeta` protobuf layout. Use a matching upstream OpenShell CLI until
NVIDIA publishes a compatible release.

The sandbox image owns:

- `/usr/local/bin/openeral`
- `fuse3`
- Node.js and optional OpenClaw runtime support
- `/etc/fstab` entries for `/db` and `/home/agent`
- `/etc/openshell/policy.yaml`

The gateway must set `OPENSHELL_DOCKER_FUSE_DEVICE=/dev/fuse`; otherwise Docker
will not map `/dev/fuse` into sandbox containers and the FUSE mounts will fail.

## Mounts

The image declares:

```text
env /db fuse.openeral ro,allow_other,noauto 0 0
env#workspace#${OPENSHELL_SANDBOX_ID} /home/agent fuse.openeral rw,allow_other,noauto 0 0
```

At sandbox startup:

- provider env supplies `DATABASE_URL`
- the supervisor maps it to `OPENERAL_DATABASE_URL`
- `mount.fuse3` starts `openeral`
- `/db` is read-only database context
- `/home/agent` is the writable durable Claude home
- the supervisor runs `openeral bootstrap` after FUSE mounts are ready
- `.claude` defaults, optional Socket.dev npm config, optional StringCost
  settings, and optional OpenClaw config are prepared before the agent starts

`openeral bootstrap` is a normal CLI subcommand. If openeral CLI subcommands
change, update `crates/openeral-core/src/cli/fuse_fd.rs::KNOWN_SUBCOMMANDS` so
the mount.fuse3 invocation detector never treats a subcommand as a FUSE source.

Create the `db` provider with the OpenShell CLI env-lookup form:

```bash
DATABASE_URL="$OPENERAL_DATABASE_URL" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name db \
  --type generic \
  --credential DATABASE_URL
```

Do not pass `DATABASE_URL=...` directly in the `--credential` argument. The
env-lookup form keeps secrets out of argv and is the supported docs path.

## Claude Code

Run Claude with:

```bash
HOME=/home/agent claude
```

Non-interactive check:

```bash
HOME=/home/agent claude -p 'Reply with READY and nothing else.'
```

Claude state must persist under `/home/agent`, especially:

- `/home/agent/.claude.json`
- `/home/agent/.claude/settings.json`
- `/home/agent/.claude/projects/...`

Do not treat `/sandbox` as durable state.

The bootstrap step sets `HOME=/home/agent` for the child environment and for
OpenShell reconnect shells. Keeping the explicit `HOME=/home/agent` prefix in
commands is still recommended because it makes the persistence contract visible.

## Optional Providers

Socket.dev package registry:

```bash
SOCKET_TOKEN="$SOCKET_TOKEN" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name socket \
  --type generic \
  --credential SOCKET_TOKEN
```

When present, bootstrap writes `/tmp/openeral-npmrc` with an OpenShell
placeholder token and sets `NPM_CONFIG_USERCONFIG`. It never writes
`/home/agent/.npmrc`.

StringCost:

```bash
STRINGCOST_API_KEY="$STRINGCOST_API_KEY" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name stringcost \
  --type generic \
  --credential STRINGCOST_API_KEY
```

When present with `ANTHROPIC_API_KEY`, bootstrap creates or reuses a presign,
stores only the presign metadata under `/home/agent/.openeral`, and configures
Claude/OpenClaw to use `ANTHROPIC_BASE_URL`.

OpenClaw:

```bash
OPENERAL_AGENT=openclaw openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name openclaw \
  --type generic \
  --credential OPENERAL_AGENT
```

Then launch with `--provider openclaw -- env HOME=/home/agent openclaw`.

## Policy

This image replaces the base OpenShell policy with:

```text
/etc/openshell/policy.yaml
```

That policy is copied from `sandboxes/openeral/policy.yaml` and is part of the
runtime contract. It allows Claude's Anthropic traffic and keeps
`ANTHROPIC_API_KEY` as a child-visible placeholder that the OpenShell proxy
rewrites at egress.

It also includes optional policies for OpenClaw, StringCost, Socket.dev, npm,
GitHub release downloads, PyPI, VS Code, Cursor, and Copilot.

If Claude auth fails, check both:

- the `claude` provider contains `ANTHROPIC_API_KEY`
- `/etc/openshell/policy.yaml` still contains the Anthropic REST endpoint and
  `secret_injection` rule

Create the `claude` provider with:

```bash
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" openshell provider create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name claude \
  --type generic \
  --credential ANTHROPIC_API_KEY
```

## Fresh Machine Usage

Use the root `README.md` flow. The important sandbox command is:

```bash
openshell sandbox create \
  --gateway "$OPENERAL_GATEWAY_NAME" \
  --name "$OPENERAL_SANDBOX_NAME" \
  --from "$OPENERAL_SANDBOX_IMAGE" \
  --provider db \
  --provider claude \
  --auto-providers \
  --no-tty -- env HOME=/home/agent claude
```
