---
name: openeral-dev
description: Develop and verify the openeral OpenShell Docker-driver flow whose goal is a working Claude Code with persistent /home/agent
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
argument-hint: [task description]
---

# OpenEral Development

Optimize for one product result:

- upstream OpenShell CLI drives the session
- openeral Docker-driver gateway starts sandboxes
- `/dev/fuse` is mapped by the Docker compute driver
- the patched supervisor mounts `/db` and `/home/agent` from `/etc/fstab`
- Claude Code runs with `HOME=/home/agent`
- `.claude` persists to PostgreSQL

## Runtime Contract

The supported runtime image set is:

- `gateway`
- `supervisor`
- `sandbox`

The supported OpenShell runtime path is the Docker compute driver. Keep gateway,
supervisor, and sandbox images version-locked.

The user-facing CLI remains the upstream released `openshell` binary.
CLI/gateway protobuf compatibility is part of the product contract. If the
upstream CLI cannot create providers or sandboxes against the openeral gateway,
fix the version pairing or gateway source; do not hide the problem behind a
repo-local wrapper or vendored CLI in the user flow.

## Files That Matter Most

- `crates/openeral-core/src/fs/workspace.rs` — writable workspace persistence
- `crates/openeral-core/src/db/queries/workspace.rs` — workspace file storage
- `sandboxes/openeral/Dockerfile` — published sandbox image
- `sandboxes/openeral/policy.yaml` — image-owned sandbox policy
- `vendor/openshell/crates/openshell-driver-docker/src/lib.rs` — Docker sandbox container spec and `/dev/fuse` device mapping
- `vendor/openshell/crates/openshell-sandbox/src/fuse.rs` — supervisor FUSE startup from `/etc/fstab`
- `vendor/openshell/crates/openshell-sandbox/src/l7/relay.rs` — REST proxy logging and placeholder rewrite path
- `.github/scripts/smoke_openshell.sh` — product smoke test
- `tests/test_live_secret_injection.sh` — live Claude and boundary secret-injection test
- `.github/workflows/publish-images.yml` — build, smoke, publish

## Verification Order

Primary product check:

```bash
bash .github/scripts/smoke_openshell.sh
```

This is verification automation, not the user interface. README and skill
instructions must remain composed `docker` and `openshell` commands.

GitHub Actions local check:

```bash
act push -W .github/workflows/publish-images.yml
```

Lower-level checks:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
bash tests/test_live_secret_injection.sh
cargo test --manifest-path vendor/openshell/Cargo.toml \
  -p openshell-driver-docker \
  -p openshell-policy \
  -p openshell-sandbox
```

If OpenShell runtime code changes, rebuild images and restart the whole stack
from scratch before claiming success.

## Live Success Criteria

The end-to-end run must prove:

- `/dev/fuse` exists inside the sandbox
- `/db` is mounted
- `/home/agent` is mounted and writable
- Claude runs with `HOME=/home/agent`
- `.claude` or a workspace test file appears in `_openeral.workspace_files`
- child-visible `ANTHROPIC_API_KEY` remains a placeholder when secret injection is under test

## Hard Rules

- Keep the supported user flow command-composed, not wrapper-script based.
- Provider secrets use `--credential NAME` with host env values, never
  `--credential NAME=value` in documentation.
- Never delete, move, or overwrite user files without explicit permission.
- Do not treat `/sandbox` as durable state.
- Do not validate FUSE by bypassing the OpenShell supervisor path.
