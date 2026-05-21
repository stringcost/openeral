# OpenEral

OpenEral currently runs on the OpenShell embedded-k3s path with:

- a stock `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` sandbox
- a writable durable workspace at `/sandbox`
- a read-only database browser at `/sandbox/.db`
- a fast local home at `/home/agent`
- a durable Claude config directory mounted at `/home/agent/.claude`
- a host-mounted source tree at `/sandbox/project`
- Postgres-backed workspace rows in `_openeral.workspace_files`

The old "make the whole home directory durable" contract is no longer the
current runtime story. Only Claude's config directory is mounted from the
Postgres-backed workspace.

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
- `HOME=/home/agent` and `CLAUDE_CONFIG_DIR=/home/agent/.claude` are projected
  into `sandbox exec`
- `/home/agent/.claude` is a real mount, not a symlink
- Claude config persists under workspace path `/.claude/.claude.json`
- `/sandbox/project` is host-mounted and is not mirrored into
  `_openeral.workspace_files`
- first-run `claude -p` has produced `READY` through the OpenShell
  policy/proxy path

## Known Gap

The remaining known issue is full end-to-end verification after the latest FUSE
`O_TRUNC` fix.

Current understanding:

- the storage path is working
- the provider-env placeholder path is working
- the policy path for Claude traffic is working
- Claude starts and reaches Claude Code / Anthropic endpoints through
  `sandbox exec`
- the mounted `.claude` directory shape is in place
- the previous live failure was a stale-tail JSON row after
  `Path.write_text()` rewrote `.claude/.claude.json`
- the code now handles `FUSE_ATOMIC_O_TRUNC`, but the full READY /
  READY-AGAIN smoke still needs a fresh run because the stack was stopped

Do not read the current docs as claiming a fully clean READY / READY-AGAIN
Supabase smoke until `tests/test_live_supabase_env.sh` passes after that fix.

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
- `HOME=/home/agent`
- `CLAUDE_CONFIG_DIR=/home/agent/.claude`

Expected behavior inside a healthy sandbox:

- `/sandbox` is the durable writable path
- `/sandbox/.db` is the read-only database browser
- `/home/agent` is local and fast
- `/home/agent/.claude` is a mounted directory backed by workspace path
  `/.claude`
- `/home/agent/.claude/.claude.json` persists as
  `/.claude/.claude.json`
- `/home/agent/.claude.json` should not exist
- `/sandbox/project` is a host mount for the source tree
- writing a file under `/sandbox` updates `_openeral.workspace_files`
- writing under `/sandbox/project` does not update `_openeral.workspace_files`
- same-name recreate on the same database restores `/sandbox` state
- same-name recreate restores the mounted Claude config directory

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
- `/home/agent/.claude` mounted-directory semantics
- absence of legacy `/home/agent/.claude.json`
- `/sandbox/project` host-mount behavior
- `/.db` existence and write denial
- Postgres-backed workspace persistence
- Claude config marker persistence through `/.claude/.claude.json`
- same-name recreate persistence

Implementation details that matter for the live harness:

- it prefers a repo-built `openshell` binary run inside a containerized runner
- it stages the stock community sandbox image through the local registry
- it uses a short-lived initial create command so `sandbox create` returns
- it keeps the cluster on failure when `OPENERAL_KEEP_CLUSTER_ON_FAILURE=1`

It also exercises the current Claude path. After the FUSE `O_TRUNC` fix, rerun
the full script before claiming the live smoke is green.

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

## FUSE Notes

Claude writes config with normal filesystem semantics, including atomic rename
and truncating rewrites. The Openeral FUSE layer must preserve those semantics:

- keep request handling multi-threaded with cloned FUSE fds
- keep long kernel metadata TTLs for the single-daemon writer model
- keep directory operations parallel
- do not enable `FUSE_WRITEBACK_CACHE` for the Postgres-backed workspace
- handle `O_TRUNC` in `open()` via `FUSE_ATOMIC_O_TRUNC`
- preserve inode identity across rename so atomic config saves do not leave
  cached dentries pointing at forgotten paths

## Related Docs

Relevant repo-owned surfaces:

- [tests/test_live_supabase_env.sh](/home/sss/Code/pgmount/tests/test_live_supabase_env.sh)
- [sandboxes/openeral/policy.yaml](/home/sss/Code/pgmount/sandboxes/openeral/policy.yaml)
- [.claude/skills/openeral-shell/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-shell/SKILL.md)
- [.claude/skills/openeral-dev/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-dev/SKILL.md)
- [.claude/skills/openeral-navigate/SKILL.md](/home/sss/Code/pgmount/.claude/skills/openeral-navigate/SKILL.md)
