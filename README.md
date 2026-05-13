# OpenEral

OpenEral currently runs Claude Code inside OpenShell with:

- a stock `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` sandbox
- a persistent writable workspace at `/sandbox`
- a read-only database browser at `/sandbox/.db`
- Postgres-backed workspace rows stored in `_openeral.workspace_files`

The current repo runtime is the embedded-k3s path. The old Docker-driver
`/home/agent` contract is no longer the supported flow.

## Environment Contract

The supported external database variable is:

```bash
OPENERAL_DATABASE_URL=postgresql://...
```

OpenEral does not auto-load `.env` files inside the binaries. The supported
workflow is to source `.env` in the shell first:

```bash
set -a
. ./.env
set +a
```

Required environment for the live external-DB flow:

- `OPENERAL_DATABASE_URL`
- `ANTHROPIC_API_KEY`

Optional environment:

- `OPENSHELL_BIN`
- `OPENSHELL_CLUSTER_IMAGE`
- `OPENSHELL_REGISTRY_HOST`
- `OPENSHELL_REGISTRY_ENDPOINT`
- `OPENSHELL_REGISTRY_INSECURE`
- `IMAGE_REPO_BASE`
- `IMAGE_TAG`
- `OPENSHELL_PUSH_IMAGES`

## Supabase

Supabase works when `OPENERAL_DATABASE_URL` is a valid PostgreSQL connection
string. For the current Openeral/OpenShell flow, use the Supabase **session
pooler** URL, not the transaction pooler.

Before touching OpenShell, verify the credential directly:

```bash
set -a
. ./.env
set +a

psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

If that fails, the problem is the credential or Supabase endpoint, not
OpenEral.

## Current Runtime Contract

The current supported runtime shape is:

- OpenShell gateway/cluster started through `openshell gateway start`
- Openeral CSI mounted into the embedded k3s node
- stock community `base` sandbox image
- `HOME=/sandbox`

Expected behavior inside a healthy sandbox:

- `/sandbox` is writable
- `/sandbox/.db` exists and is read-only
- writing a file under `/sandbox` creates or updates a row in
  `_openeral.workspace_files`
- `claude -p ...` runs with `HOME=/sandbox`
- deleting and recreating the same sandbox name on the same database preserves
  `/sandbox` state

## Validation

For the current repo, the supported live external-DB validation path is:

```bash
set -a
. ./.env
set +a

bash tests/test_live_supabase_env.sh
```

The script:

- validates `OPENERAL_DATABASE_URL` with plain `psql`
- starts the current OpenShell gateway/cluster flow
- creates `db` and `claude` providers from the sourced environment
- creates a stock `base` sandbox
- verifies `/sandbox` and `/sandbox/.db`
- writes a workspace file and checks the corresponding Postgres row
- verifies writes under `/.db` are rejected
- runs `claude -p 'Reply with READY and nothing else.'`
- deletes and recreates the same sandbox name and verifies persistence

The script is intentionally non-destructive to application tables. It only
creates Openeral workspace rows in the configured database.

## OpenShell CLI

The OpenShell CLI must match the gateway/server protocol. For local repo work,
prefer a matching build from `vendor/openshell` or point the validation script
at a known-good binary:

```bash
export OPENSHELL_BIN="$PWD/.tmp/openshell-target/release/openshell"
```

If `OPENSHELL_BIN` is unset, the validation script uses:

1. `./.tmp/openshell-target/release/openshell`
2. `./vendor/openshell/target/release/openshell`
3. `openshell` from `PATH`

## Local Dev Image Defaults

`tests/test_live_supabase_env.sh` defaults to the current local-dev image flow:

- `OPENSHELL_CLUSTER_IMAGE=127.0.0.1:5000/openeral/cluster:dev`
- `OPENSHELL_REGISTRY_HOST=127.0.0.1:5000`
- `OPENSHELL_REGISTRY_ENDPOINT=172.17.0.1:5000`
- `OPENSHELL_REGISTRY_INSECURE=true`
- `IMAGE_REPO_BASE=127.0.0.1:5000/openeral`
- `IMAGE_TAG=dev`
- `OPENSHELL_PUSH_IMAGES=ghcr.io/nvidia/openshell/gateway:dev,ghcr.io/nvidia/openshell/supervisor:dev`

Override those in the shell if you want to validate another image set.

## Related Checks

The existing repo tests still matter, but they are not the external-Supabase
proof:

- [tests/test_fuse_mount.sh](/home/sss/Code/pgmount/tests/test_fuse_mount.sh)
- [tests/test_live_secret_injection.sh](/home/sss/Code/pgmount/tests/test_live_secret_injection.sh)
- [.github/scripts/smoke_openshell.sh](/home/sss/Code/pgmount/.github/scripts/smoke_openshell.sh)

Those remain useful for deterministic local validation. Use
[tests/test_live_supabase_env.sh](/home/sss/Code/pgmount/tests/test_live_supabase_env.sh)
when the goal is specifically “does the current stack work against the
shell-sourced Supabase URL from `.env`?”.
