# OpenEral

OpenEral currently runs on the OpenShell embedded-k3s path with:

- a stock `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` sandbox
- a writable durable workspace at `/sandbox`
- a read-only database browser at `/sandbox/.db`
- Postgres-backed workspace rows in `_openeral.workspace_files`

The old Docker-driver `/home/agent` contract is no longer the current runtime
story.

## Verified Now

What is already verified on the current stack:

- `OPENERAL_DATABASE_URL` from a shell-sourced `.env` works with plain `psql`
- `/sandbox` mounts successfully on the k3s/CSI path
- `/.db` exists and rejects writes
- `sandbox exec` child processes see provider placeholders such as
  `ANTHROPIC_API_KEY=openshell:resolve:env:ANTHROPIC_API_KEY`
- workspace writes persist to `_openeral.workspace_files`
- deleting and recreating the same sandbox name on the same database preserves
  `/sandbox` state
- Claude starts inside the sandbox and reaches Anthropic through the OpenShell
  policy/proxy path

## Known Gap

The remaining known issue is the final `claude -p ...` completion path through
`openshell sandbox exec`.

Current understanding:

- the storage path is working
- the provider-env placeholder path is working
- the policy path for Claude traffic is working
- Claude starts and reaches Claude Code / Anthropic endpoints
- but the final `claude -p ...` completion still does not return cleanly within
  the current smoke timeout

Do not read the current docs as claiming a fully clean “READY / READY-AGAIN”
Supabase smoke yet.

## Environment Contract

The supported external database variable is:

```bash
OPENERAL_DATABASE_URL=postgresql://...
```

The binaries do not auto-load `.env`. Source it in the shell:

```bash
set -a
. ./.env
set +a
```

Required env for live external-DB validation:

- `OPENERAL_DATABASE_URL`
- `ANTHROPIC_API_KEY`

Preflight the database directly before touching OpenShell:

```bash
psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'
```

If that fails, the problem is the credential or PostgreSQL endpoint, not
OpenEral.

For Supabase, use the session-pooler URL, not the transaction-pooler URL.

## Runtime Contract

The current runtime shape is:

- OpenShell gateway/cluster started via `openshell gateway start`
- Openeral CSI mounted into the embedded k3s node
- stock community `base` sandbox image
- explicit policy override from `sandboxes/openeral/policy.yaml`
- `HOME=/sandbox`

Expected behavior inside a healthy sandbox:

- `/sandbox` is the durable writable path
- `/sandbox/.db` is the read-only database browser
- writing a file under `/sandbox` updates `_openeral.workspace_files`
- same-name recreate on the same database restores `/sandbox` state

## Validation

There are two useful validation lanes:

Deterministic local checks:

```bash
cargo test -p openeral-core
bash tests/test_fuse_mount.sh
bash tests/test_live_secret_injection.sh
```

Live external-DB check:

```bash
set -a
. ./.env
set +a

bash tests/test_live_supabase_env.sh
```

That script is the current live Supabase harness. It is meant for developers,
not end users. It validates:

- `psql` preflight
- gateway/cluster startup
- provider placeholder projection on the real `sandbox exec` path
- `/sandbox` mount
- `/.db` existence and write denial
- Postgres-backed workspace persistence
- same-name recreate persistence

Implementation details that matter for the live harness:

- it prefers a repo-built `openshell` binary run inside a containerized runner
- it stages the stock community sandbox image through the local registry
- it uses a short-lived initial create command so `sandbox create` returns
- it keeps the cluster on failure when `OPENERAL_KEEP_CLUSTER_ON_FAILURE=1`

It also exercises the current Claude path, but the final `claude -p`
completion is still the known gap.

## OpenShell CLI

Use a matching `openshell` binary. For repo work, prefer a repo-built CLI:

```bash
export OPENSHELL_BIN="$PWD/.tmp/openshell-target/release/openshell"
```

In this repo, the host `PATH` may still point at an older `openshell`. The
live harness prefers a repo-built binary inside a runner image when available.

If `OPENSHELL_BIN` is unset, the live script falls back to:

1. `./.tmp/openshell-target/release/openshell`
2. `./vendor/openshell/target/release/openshell`
3. `openshell` from `PATH`

## Local Dev Image Expectations

The live Supabase harness is written around local dev images and a local
registry. In the default path it expects these images to exist locally:

- `openshell/cluster:dev`
- `openeral/cluster:dev`
- `openshell/gateway:dev`
- `openshell/supervisor:dev`
- either `openeral/openshell-cli-runner:dev` or `openshell/ci:dev`
- `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` is pulled
  locally and mirrored to `127.0.0.1:5000/openeral/sandbox-base:latest`

The script mirrors the cluster, gateway, supervisor, and sandbox base images
into the local registry path it uses for the run.

## Related Docs

Relevant repo-owned surfaces:

- [tests/test_live_supabase_env.sh](/home/sss/Code/pgmount/tests/test_live_supabase_env.sh)
- [sandboxes/openeral/policy.yaml](/home/sss/Code/pgmount/sandboxes/openeral/policy.yaml)
- [.claude/skills/openeral-shell/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-shell/SKILL.md)
- [.claude/skills/openeral-dev/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-dev/SKILL.md)
- [.claude/skills/openeral-navigate/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-navigate/SKILL.md)
