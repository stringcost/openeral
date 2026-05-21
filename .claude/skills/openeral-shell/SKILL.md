---
name: openeral-shell
description: Run the current Openeral/OpenShell k3s flow with durable /sandbox, mounted Claude config, read-only /.db, and shell-sourced OPENERAL_DATABASE_URL
---

# OpenEral Shell

Use this when the goal is to operate the current Openeral stack, not the old
whole-home persistence path.

Assume:

- the durable writable path is `/sandbox`
- the database browser path is `/sandbox/.db`
- the fast local home is `/home/agent`
- `CLAUDE_CONFIG_DIR=/home/agent/.claude`
- `/home/agent/.claude` is a mounted directory backed by workspace path
  `/.claude`
- `/home/agent/.claude/.claude.json` is the active top-level Claude config
- `/sandbox/project` is the host-mounted source tree
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
- `sandbox exec` children see provider placeholders
- workspace writes persist to `_openeral.workspace_files`
- same-name recreate on the same database restores state
- Claude starts and reaches Anthropic
- `sandbox exec` uses `HOME=/home/agent`
- Claude config persists through the mounted `.claude` directory
- host project writes stay out of the Postgres workspace

Known gap:

- rerun the full READY / READY-AGAIN smoke after the latest FUSE `O_TRUNC`
  fix; the stack was stopped before that final verification completed

## Live Validation

Use:

```bash
bash tests/test_live_supabase_env.sh
```

Treat that as the current live harness for the shell-sourced Supabase flow. It
is the storage, Claude-config, host-project, and recreate proof. Do not describe
it as green until it passes after the current FUSE truncate fix.

Current harness behavior that matters:

- it prefers a repo-built `openshell` binary inside a runner image
- it can fall back from `openeral/openshell-cli-runner:dev` to
  `openshell/ci:dev`
- it mirrors the stock community base sandbox image into the local registry
- it uses a short-lived initial create command so `sandbox create` returns
- it checks `/home/agent/.claude` mount semantics and semantic persistence of
  `/.claude/.claude.json`
- it checks `/sandbox/project` is host-mounted and not persisted to Postgres

## OpenShell CLI

Prefer a repo-built `openshell` binary:

```bash
export OPENSHELL_BIN="$PWD/.tmp/openshell-target/release/openshell"
```

Do not assume the host `openshell` on `PATH` is the right binary for repo
validation. The shell path may still point at an older install.

The validation path expects the current local dev images and local registry
mirror to exist or be built first.

## Hard Rules

- Do not document whole-home persistence as the current runtime.
- Do not document `/home/agent/.claude.json` as the active config path.
- Do not document top-level `/db` as the current runtime.
- Do not use `POSTGRES_URL` as the supported Openeral input variable.
- Do not rely on implicit `.env` loading.
- Keep docs honest about the pending full-smoke rerun after the FUSE `O_TRUNC`
  fix.
