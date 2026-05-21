---
name: openeral-dev
description: Develop and verify the current Openeral/OpenShell k3s flow with durable /sandbox backed by PostgreSQL
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
argument-hint: [task description]
---

# OpenEral Development

Optimize for one product result:

- OpenShell runs through the embedded-k3s path
- Openeral storage is mounted at `/sandbox`
- `/.db` is read-only database context under `/sandbox/.db`
- Claude uses local `HOME=/home/agent`
- Claude config is persisted by mounting `/.claude` at `/home/agent/.claude`
- source code is host-mounted at `/sandbox/project`
- workspace rows persist in PostgreSQL

## Current Verified State

Verified:

- `OPENERAL_DATABASE_URL` works when shell-sourced from `.env`
- `/sandbox` and `/.db` behave correctly
- provider placeholders are visible on the real `sandbox exec` path
- same-name recreate preserves workspace state
- the truncate/overwrite storage bug against Supabase is fixed
- `/home/agent/.claude` is mounted as a real directory, not symlinked
- `CLAUDE_CONFIG_DIR=/home/agent/.claude` is projected into `sandbox exec`
- `/home/agent/.claude.json` is absent; top-level Claude config lives at
  `/home/agent/.claude/.claude.json`
- `/sandbox/project` is host-mounted and excluded from workspace persistence
- first-run `claude -p` has returned `READY` through the live exec path

Still open:

- rerun the full READY / READY-AGAIN smoke after the latest FUSE `O_TRUNC`
  fix
- the latest live failure was stale-tail JSON in `/.claude/.claude.json` after
  a truncating rewrite; code now handles `FUSE_ATOMIC_O_TRUNC`, but the stack
  was stopped before a full rerun completed

Do not collapse those into one “everything is green” story.

## Environment Contract

The supported external DB variable is:

- `OPENERAL_DATABASE_URL`

The shell must source `.env` explicitly:

```bash
set -a
. ./.env
set +a
```

No dotenv loading belongs inside the binaries.

## Verification Order

Preflight:

```bash
psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

Regression for the fixed truncate path:

```bash
TEST_DATABASE_URL="$OPENERAL_DATABASE_URL" \
  cargo test -p openeral-core \
  test_update_file_attrs_truncate_and_overwrite_sequence -- --nocapture
```

Deterministic local checks:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
bash tests/test_live_secret_injection.sh
```

Current live external-DB check:

```bash
bash tests/test_live_supabase_env.sh
```

Current smoke mechanics:

- repo-built `openshell` is expected to run in a containerized runner
- the runner can be `openeral/openshell-cli-runner:dev` or `openshell/ci:dev`
- source images are `openshell/gateway:dev`, `openshell/supervisor:dev`,
  `openshell/cluster:dev`, plus `openeral/cluster:dev`
- the stock community base sandbox image is mirrored into the local registry
- `sandbox create` uses a short-lived initial command so the create call
  returns before later `sandbox exec` checks
- `OPENERAL_KEEP_CLUSTER_ON_FAILURE=1` preserves the live cluster for
  inspection
- the smoke asserts `HOME=/home/agent` and
  `CLAUDE_CONFIG_DIR=/home/agent/.claude`
- the smoke asserts `/home/agent/.claude` is a mount and
  `/home/agent/.claude.json` is absent
- the smoke writes a semantic marker through
  `/home/agent/.claude/.claude.json` and verifies the Postgres row at
  `/.claude/.claude.json`
- the smoke asserts `/sandbox/project` writes stay out of Postgres

## Files That Matter Most

- `crates/openeral-core/src/fs/sandbox.rs`
- `crates/openeral-core/src/fs/workspace_inode.rs`
- `crates/openeral-core/src/cli/bootstrap.rs`
- `crates/openeral-core/src/db/queries/workspace.rs`
- `crates/openeral-csi/src/main.rs`
- `vendor/openshell/crates/openshell-driver-kubernetes/src/driver.rs`
- `vendor/openshell/crates/openshell-sandbox/src/lib.rs`
- `tests/test_live_supabase_env.sh`
- `sandboxes/openeral/policy.yaml`

## Hard Rules

- Do not make the whole home directory durable again.
- Do not replace the mounted `.claude` directory design with copy-in/copy-out
  sync unless the product requirement changes.
- Do not describe `/home/agent/.claude.json` as the active config path.
- Do not reintroduce `POSTGRES_URL` as the supported external contract.
- Do not treat a failing `psql` preflight as an Openeral runtime bug.
- Keep the full-smoke verification gap explicit until READY / READY-AGAIN is
  rerun after the FUSE `O_TRUNC` fix.
