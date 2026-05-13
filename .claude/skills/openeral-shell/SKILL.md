---
name: openeral-shell
description: Run the current Openeral/OpenShell k3s flow with a persistent PostgreSQL-backed /sandbox and read-only /.db
---

# OpenEral Shell

Use this when the goal is to run Claude Code against the current Openeral stack.

Assume:

- the durable writable path is `/sandbox`
- the database browser path is `/sandbox/.db`
- `HOME=/sandbox`
- the external database variable is `OPENERAL_DATABASE_URL`
- `.env` must be sourced by the shell before running commands
- there is no dotenv auto-load inside the binaries

## First Checks

Source `.env` explicitly:

```bash
set -a
. ./.env
set +a
```

Required env:

- `OPENERAL_DATABASE_URL`
- `ANTHROPIC_API_KEY`

Preflight the database directly:

```bash
psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

If that fails, stop there. The problem is the credential or the PostgreSQL
endpoint, not OpenEral.

## Supported Live Validation

The supported live repo check is:

```bash
bash tests/test_live_supabase_env.sh
```

That script validates the actual product properties:

- `/sandbox` mounts successfully
- `/sandbox/.db` exists and is read-only
- writing under `/sandbox` persists to `_openeral.workspace_files`
- `claude -p 'Reply with READY and nothing else.'` succeeds
- deleting and recreating the same sandbox name preserves workspace state

## OpenShell CLI

Use a matching `openshell` binary. Prefer:

```bash
export OPENSHELL_BIN="$PWD/.tmp/openshell-target/release/openshell"
```

If unset, the validation script falls back to:

1. `./.tmp/openshell-target/release/openshell`
2. `./vendor/openshell/target/release/openshell`
3. `openshell` from `PATH`

## Hard Rules

- Do not use `POSTGRES_URL` as the supported Openeral input variable.
- Do not rely on implicit `.env` loading.
- Do not document `/home/agent` or top-level `/db` as the current runtime.
- Keep external database docs on `OPENERAL_DATABASE_URL`.
