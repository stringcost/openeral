# CLAUDE.md

For using openeral without developing it, see `README.md` and
`sandboxes/openeral/README.md`.

## Product Goal

OpenEral exists to run Claude Code inside OpenShell with persistent state:

- Claude runs with `HOME=/home/agent`
- `/home/agent` is a PostgreSQL-backed writable FUSE mount
- `/db` is a read-only database context mount
- `.claude` persists in `_openeral.workspace_files`

## Runtime Model

The supported OpenShell flow uses the upstream `openshell` CLI with openeral
runtime images:

- `gateway` — patched OpenShell gateway using the Docker compute driver
- `supervisor` — patched `openshell-sandbox` binary with `/etc/fstab` FUSE startup
- `sandbox` — Claude Code, `openeral`, `fuse3`, and the openeral policy

The gateway is started as a Docker container and registered with:

```bash
openshell gateway add --local --name openeral http://127.0.0.1:8080
```

## Build & Test

Primary product validation:

```bash
bash .github/scripts/smoke_openshell.sh
```

Local GitHub Actions validation:

```bash
act push -W .github/workflows/publish-images.yml
```

Lower-level checks:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
cargo test --manifest-path vendor/openshell/Cargo.toml \
  -p openshell-driver-docker \
  -p openshell-policy \
  -p openshell-sandbox
```

If a change affects the OpenShell runtime path, rebuild images from scratch and
restart the whole stack. Do not repair a half-started gateway or sandbox and
call that validation.

## Project Structure

- `crates/openeral/` — openeral binary entry point
- `crates/openeral-core/` — FUSE filesystems, DB queries, migrations, CLI logic
- `crates/openeral-core/migrations/` — PostgreSQL schema migrations
- `sandboxes/openeral/` — supported sandbox image and policy
- `vendor/openshell/` — vendored OpenShell source used for gateway/supervisor images
- `.github/workflows/publish-images.yml` — builds, smokes, and publishes runtime images
- `.github/scripts/smoke_openshell.sh` — Docker-driver OpenShell smoke test
- `tests/test_fuse_mount.sh` — direct FUSE integration test
- `tests/test_live_secret_injection.sh` — live Claude and boundary secret-injection test

## Hard Rules

- Never delete, move, or overwrite user files without explicit permission.
- If a file appears risky, secret-bearing, or security-critical, stop and ask before changing it.
- Keep the user-facing flow command-composed; do not add wrapper scripts for normal usage.
- The supported OpenShell runtime path is Docker compute driver with gateway, supervisor, and sandbox images.
- Do not validate OpenShell by bypassing the supervisor; FUSE mounts must come from `/etc/fstab`.

## Implementation Notes

- Workspace ownership must resolve to the sandbox user, not a hardcoded UID.
- `/dev/fuse` is supplied by the Docker driver through `HostConfig.devices`.
- The gateway container must mount a host path at the same path used for `XDG_DATA_HOME`; Docker later bind-mounts the extracted supervisor binary from that host-visible path into sandbox containers.
- The sandbox policy is image-owned at `/etc/openshell/policy.yaml`.
