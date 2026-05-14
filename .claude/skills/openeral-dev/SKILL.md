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
- workspace rows persist in PostgreSQL

## Current Verified State

Verified:

- `OPENERAL_DATABASE_URL` works when shell-sourced from `.env`
- `/sandbox` and `/.db` behave correctly
- same-name recreate preserves workspace state
- the truncate/overwrite storage bug against Supabase is fixed

Still open:

- clean final `claude -p` completion through `openshell sandbox exec`

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

## Files That Matter Most

- `crates/openeral-core/src/fs/sandbox.rs`
- `crates/openeral-core/src/db/queries/workspace.rs`
- `crates/openeral-csi/src/main.rs`
- `tests/test_live_supabase_env.sh`
- `sandboxes/openeral/policy.yaml`

## Hard Rules

- Do not switch the docs back to `/home/agent`.
- Do not reintroduce `POSTGRES_URL` as the supported external contract.
- Do not treat a failing `psql` preflight as an Openeral runtime bug.
- Keep the known Claude completion gap explicit until it is actually fixed and
  reverified.
