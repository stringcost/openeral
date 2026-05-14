---
name: openeral-shell
description: Run the current Openeral/OpenShell k3s flow with durable /sandbox, read-only /.db, and shell-sourced OPENERAL_DATABASE_URL
---

# OpenEral Shell

Use this when the goal is to operate the current Openeral stack, not the old
`/home/agent` Docker-driver path.

Assume:

- the durable writable path is `/sandbox`
- the database browser path is `/sandbox/.db`
- `HOME=/sandbox`
- the external DB variable is `OPENERAL_DATABASE_URL`
- `.env` must be sourced explicitly by the shell

## First Checks

```bash
set -a
. ./.env
set +a

psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

If that fails, stop there. That is a credential or PostgreSQL issue, not an
OpenEral issue.

## Current Reality

Verified now:

- `/sandbox` mounts
- `/.db` exists and is read-only
- workspace writes persist to `_openeral.workspace_files`
- same-name recreate on the same database restores state
- Claude starts and reaches Anthropic

Known gap:

- the final `claude -p ...` completion path through `openshell sandbox exec`
  still does not return cleanly in every run

## Live Validation

Use:

```bash
bash tests/test_live_supabase_env.sh
```

Treat that as the current live harness for the shell-sourced Supabase flow. It
is the best storage/persistence proof, but it should not yet be described as a
fully green Claude smoke.

## OpenShell CLI

Prefer a repo-built `openshell` binary:

```bash
export OPENSHELL_BIN="$PWD/.tmp/openshell-target/release/openshell"
```

The validation path expects the current local dev images and local registry
mirror to exist or be built first.

## Hard Rules

- Do not document `/home/agent` or top-level `/db` as the current runtime.
- Do not use `POSTGRES_URL` as the supported Openeral input variable.
- Do not rely on implicit `.env` loading.
- Keep docs honest about the current Claude completion gap.
