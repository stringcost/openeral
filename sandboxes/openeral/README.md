# OpenEral Sandbox

This image is the OpenShell sandbox runtime for Claude Code with a persistent
PostgreSQL-backed home at `/home/agent`.

It is not a standalone entrypoint image. OpenShell starts the patched
`openshell-sandbox` supervisor, and the supervisor mounts the FUSE filesystems
declared in this image's `/etc/fstab`.

## Runtime Contract

The supported flow uses:

- upstream `openshell` CLI on the host
- openeral `gateway` image running the OpenShell Docker compute driver
- openeral `supervisor` image containing the patched supervisor binary
- this openeral `sandbox` image

The sandbox image owns:

- `/usr/local/bin/openeral`
- `fuse3`
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

## Policy

This image replaces the base OpenShell policy with:

```text
/etc/openshell/policy.yaml
```

That policy is copied from `sandboxes/openeral/policy.yaml` and is part of the
runtime contract. It allows Claude's Anthropic traffic and keeps
`ANTHROPIC_API_KEY` as a child-visible placeholder that the OpenShell proxy
rewrites at egress.

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
