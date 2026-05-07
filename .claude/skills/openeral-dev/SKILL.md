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
- the patched supervisor runs `openeral bootstrap` after FUSE mounts are ready
- Claude Code runs with `HOME=/home/agent`
- `.claude` persists to PostgreSQL

## Runtime Contract

The supported runtime image set is:

- `gateway`
- `supervisor`
- `sandbox`

The supported OpenShell runtime path is the Docker compute driver. Keep gateway,
supervisor, and sandbox images version-locked.

The user-facing CLI remains the upstream `openshell` binary. CLI/gateway
protobuf compatibility is part of the product contract. The current openeral
Docker-driver gateway tracks upstream OpenShell `main`; release CLI `0.0.36` is
a known-bad pairing because it uses the older pre-`ObjectMeta` wire layout. If
the installed upstream release lags, build the matching upstream CLI from
`vendor/openshell` for local development. Do not hide version mismatch behind a
repo-local wrapper.

## Files That Matter Most

- `crates/openeral-core/src/fs/workspace.rs` — writable workspace persistence
- `crates/openeral-core/src/db/queries/workspace.rs` — workspace file storage
- `crates/openeral-core/src/cli/bootstrap.rs` — post-FUSE sandbox bootstrap
- `crates/openeral-core/src/cli/memory.rs` — persisted Claude memory refresh
- `crates/openeral-core/src/cli/fuse_fd.rs` — mount.fuse3 invocation detector;
  keep `KNOWN_SUBCOMMANDS` synced with every real CLI subcommand
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

If openeral CLI subcommands change, update
`crates/openeral-core/src/cli/fuse_fd.rs::KNOWN_SUBCOMMANDS` before testing.
Otherwise `openeral bootstrap`-style commands can be misclassified as FUSE mount
sources and fail with misleading database connection errors.

## Live Success Criteria

The end-to-end run must prove:

- `/dev/fuse` exists inside the sandbox
- `/db` is mounted
- `/home/agent` is mounted and writable
- `/home/agent/.claude/settings.json` is seeded by bootstrap
- Claude runs with `HOME=/home/agent`
- `.claude` or a workspace test file appears in `_openeral.workspace_files`
- child-visible `ANTHROPIC_API_KEY` remains a placeholder when secret injection is under test
- Socket.dev config, when provider-backed, uses `/tmp/openeral-npmrc` and never writes `~/.npmrc`

## Hard Rules

- Keep the supported user flow command-composed, not wrapper-script based.
- Provider secrets use `--credential NAME` with host env values, never
  `--credential NAME=value` in documentation.
- Never delete, move, or overwrite user files without explicit permission.
- Do not treat `/sandbox` as durable state.
- Do not validate FUSE by bypassing the OpenShell supervisor path.
- Do not add a new `openeral` subcommand without updating the mount.fuse3
  detector subcommand allowlist.
- Do not reintroduce just-bash, PGlite, `npx openeral`, or upload-based DB credential flows.
