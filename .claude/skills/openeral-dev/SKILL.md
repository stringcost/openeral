---
name: openeral-dev
description: Develop and verify the current Openeral/OpenShell k3s flow with persistent /sandbox backed by PostgreSQL
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
argument-hint: [task description]
---

# OpenEral Development

Optimize for one product result:

- OpenShell runs through the embedded-k3s path
- Openeral storage is mounted at `/sandbox`
- `/.db` is exposed as read-only database context under `/sandbox/.db`
- Claude runs with `HOME=/sandbox`
- workspace files and `.claude` state persist in PostgreSQL

## Environment Contract

The supported external database variable is:

- `OPENERAL_DATABASE_URL`

The shell must source `.env` explicitly before any live run:

```bash
set -a
. ./.env
set +a
```

Do not add dotenv loading inside the binaries.

## Verification Order

External database preflight:

```bash
psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

Current live external-DB proof:

```bash
bash tests/test_live_supabase_env.sh
```

Deterministic lower-level checks remain:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
bash tests/test_live_secret_injection.sh
```

## Files That Matter Most

- `tests/test_live_supabase_env.sh` — live external-DB validation
- `crates/openeral-csi/src/main.rs` — CSI node/controller behavior and database env consumption
- `crates/openeral-core/src/fs/sandbox.rs` — `/sandbox` plus `/.db` filesystem shape
- `crates/openeral-core/src/db/queries/workspace.rs` — persisted workspace rows
- `README.md` — shell-sourced external DB contract

## Hard Rules

- Do not switch the supported external DB variable back to `POSTGRES_URL`.
- Do not document `/home/agent` or top-level `/db` as the current runtime.
- Do not treat a failing `psql "$OPENERAL_DATABASE_URL"` preflight as an Openeral bug.
- Keep CI/local deterministic tests separate from the real Supabase validation path.
