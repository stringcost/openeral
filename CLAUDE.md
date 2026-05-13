# CLAUDE.md

For using openeral without developing it, see `README.md` and
`sandboxes/openeral/README.md`.

## Product Goal

OpenEral exists to run Claude Code inside OpenShell with persistent state:

- Claude runs with `HOME=/home/agent`
- `/home/agent` is a PostgreSQL-backed writable FUSE mount
- `/db` is a read-only database context mount
- `.claude` persists in `_openeral.workspace_files`
- bootstrap seeds Claude/OpenClaw runtime state after FUSE mounts are ready

## Runtime Model

The supported OpenShell flow uses the upstream `openshell` CLI with openeral
runtime images. The CLI must match the gateway protobuf API; upstream release
CLI `0.0.36` is a known-bad pairing for the current Docker-driver gateway
source.

- `gateway` — patched OpenShell gateway using the Docker compute driver
- `supervisor` — patched `openshell-sandbox` binary with `/etc/fstab` FUSE startup
- `sandbox` — Claude/OpenClaw runtime support, `openeral`, `fuse3`, and the openeral policy

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
- `crates/openeral-core/src/cli/bootstrap.rs` — image-owned post-FUSE bootstrap
- `crates/openeral-core/src/cli/memory.rs` — persisted Claude memory refresh
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
- Never run `sudo`, `su`, `doas`, `pkexec`, or any equivalent privilege-escalation command.
- Never place privilege-escalation command names inside double-quoted shell strings when backticks or command substitution could execute them; use single quotes or escaped literals.
- User-invoked `docker`, `act`, `buildx`, and similar container-engine commands are allowed when run as the current user, even if they talk to a rootful daemon or that daemon creates root-owned processes or containers.
- Never use privilege escalation or direct root-targeted host actions. Do not run commands explicitly as root, and do not use elevated cleanup for stuck processes or containers.
- If root-owned processes or containers already exist, interact with them only through normal user-level tools. If user-level commands are insufficient and privilege escalation would be required, stop and report the blocker.
- Keep the user-facing flow command-composed; do not add wrapper scripts for normal usage.
- The supported OpenShell runtime path is Docker compute driver with gateway, supervisor, and sandbox images.
- Do not validate OpenShell by bypassing the supervisor; FUSE mounts must come from `/etc/fstab`.
- Do not reintroduce just-bash, PGlite, `npx openeral`, or upload-based database credential flows.

## Implementation Notes

- Workspace ownership must resolve to the sandbox user, not a hardcoded UID.
- `/dev/fuse` is supplied by the Docker driver through `HostConfig.devices`.
- The gateway container must mount a host path at the same path used for `XDG_DATA_HOME`; Docker later bind-mounts the extracted supervisor binary from that host-visible path into sandbox containers.
- The sandbox policy is image-owned at `/etc/openshell/policy.yaml`.
- Every real `openeral` CLI subcommand must be listed in
  `crates/openeral-core/src/cli/fuse_fd.rs::KNOWN_SUBCOMMANDS`; otherwise the
  mount.fuse3 invocation detector can treat a subcommand as a FUSE source.
