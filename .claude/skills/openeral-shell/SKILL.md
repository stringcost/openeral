---
name: openeral-shell
description: Launch Claude Code in an OpenShell sandbox from the published OpenEral image. Optional PostgreSQL persistence and StringCost cost tracking.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
argument-hint: [optional: workspace ID]
---

# OpenEral Shell

Launch Claude Code inside an OpenShell sandbox, from the published image `ghcr.io/sandys/openeral/sandbox:just-bash`. No local clone or source build required.

## Instructions

When this skill is invoked, execute the steps below. Do not just show documentation — run the commands.

### Step 1: Check prerequisites

```bash
which docker    || echo "MISSING docker"
which openshell || echo "MISSING openshell — install: https://github.com/NVIDIA/OpenShell-Community"
which curl      || echo "MISSING curl"
echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+(set)}"
echo "STRINGCOST_API_KEY=${STRINGCOST_API_KEY:+(set)}"
echo "DATABASE_URL=${DATABASE_URL:+(set)}"
echo "POSTGRES_URL=${POSTGRES_URL:+(set)}"
```

- `ANTHROPIC_API_KEY` is required; if missing, stop and ask the user to `export ANTHROPIC_API_KEY='sk-ant-...'`.
- `STRINGCOST_API_KEY` is optional — enables cost tracking.
- `DATABASE_URL` or `POSTGRES_URL` (Supabase / Neon / RDS) is optional — enables cross-sandbox persistence. It must be delivered via `openshell sandbox create --upload` (plaintext file); the provider framework wraps credentials as placeholders that pg cannot resolve.

### Step 2: Start the OpenShell gateway if it's not running

```bash
# openshell gateway info exits 0 when a gateway is active, non-zero otherwise.
openshell gateway info >/dev/null 2>&1 || openshell gateway start
```

### Step 3: Create providers

`--auto-providers` creates the `claude` provider from the local `ANTHROPIC_API_KEY`. The optional generic `stringcost` provider must be created explicitly so the StringCost policy is attached. Create the StringCost presign on the host and upload it; inside OpenShell, provider secrets are placeholders and cannot be used as JSON body values for StringCost's `client_api_key`. Do not create a generic database provider; upload the connection string file instead.

```bash
PROVIDERS="--provider claude"   # claude is auto-created from ANTHROPIC_API_KEY
OPENERAL_INPUT=""
UPLOAD_ARGS=""

ensure_input_dir() {
  if [ -z "$OPENERAL_INPUT" ]; then
    OPENERAL_INPUT="$(mktemp -d)"
  fi
}

if [ -n "${STRINGCOST_API_KEY:-}" ]; then
  ensure_input_dir
  curl -fsS https://app.stringcost.com/v1/presign \
    -H "Authorization: Bearer $STRINGCOST_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "provider": "anthropic",
      "client_api_key": "'"$ANTHROPIC_API_KEY"'",
      "path": ["/v1/messages"],
      "expires_in": -1,
      "max_uses": -1,
      "cost_limit": 10000000,
      "tags": ["openeral"]
    }' \
    > "$OPENERAL_INPUT/presign.json"

  openshell provider create --name stringcost --type generic \
    --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY" \
    || openshell provider update stringcost \
      --credential "STRINGCOST_API_KEY=$STRINGCOST_API_KEY"
  PROVIDERS="$PROVIDERS --provider stringcost"
fi

DATABASE_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"
if [ -n "${DATABASE_URL:-}" ]; then
  ensure_input_dir
  printf '%s' "$DATABASE_URL" > "$OPENERAL_INPUT/db-url"
  chmod 600 "$OPENERAL_INPUT/db-url"
fi

if [ -n "$OPENERAL_INPUT" ]; then
  chmod -R go-rwx "$OPENERAL_INPUT"
  UPLOAD_ARGS="--upload $OPENERAL_INPUT:/sandbox/openeral-input"
fi
```

### Step 4: Create the sandbox from the published image

```bash
openshell sandbox create --tty \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  $UPLOAD_ARGS \
  $PROVIDERS --auto-providers \
  -- openeral
```

The `stringcost` provider from Step 3 is attached only when `STRINGCOST_API_KEY` is set. The upload directory is used because OpenShell accepts one `--upload` flag; `setup.sh` reads `/sandbox/openeral-input/db-url` and `/sandbox/openeral-input/presign.json` when present.

## What happens after launch

- Claude Code starts with `HOME` pointing to the isolated sandbox workspace.
- **Workspace persistence**:
  - Without `DATABASE_URL`: embedded PGlite runs in-process. Files survive restarts/reconnects within the sandbox's lifetime; lost when the sandbox is deleted.
  - With `DATABASE_URL` or `POSTGRES_URL` delivered via `/sandbox/openeral-input/db-url`: pg tunnels through OpenShell's HTTP CONNECT proxy (via `openeral-js/src/db/http-connect-socket.ts`) to Supabase / Neon / RDS. Workspace survives sandbox delete and is shared across machines. The host must be allowlisted in the image's `postgres` network policy — common Supabase poolers are pre-allowlisted.
- **With `STRINGCOST_API_KEY`**: Claude's API calls route through the uploaded StringCost presign for billing and usage metering.
- **First Claude launch**: Claude Code may ask for theme, security acknowledgement, trust for `/sandbox`, and API usage billing. This is expected first-run setup.

## Managing a running sandbox

```bash
openshell sandbox list                            # list sandboxes
openshell sandbox connect <name>                  # open an interactive shell
openshell sandbox delete <name>                   # stop and remove
openshell sandbox ssh-config <name>               # print ssh config for scripted access
```

There is no `openshell sandbox exec` subcommand. Run one-off commands via the ssh-config helper:

```bash
openshell sandbox ssh-config <name> > /tmp/sb-cfg
ssh -F /tmp/sb-cfg openshell-<name> '<command>'
```

Always prefix with `HOME=/home/agent` — SSH connects as the sandbox user whose home is `/sandbox`, but openeral keeps all state under `/home/agent`.

### Refresh Claude's memory files

From outside the sandbox:

```bash
openshell sandbox ssh-config <name> > /tmp/sb-cfg
ssh -F /tmp/sb-cfg openshell-<name> \
  'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh'

# focus on a topic
ssh -F /tmp/sb-cfg openshell-<name> \
  'HOME=/home/agent node /opt/openeral/dist/bin/openeral.js memory refresh --query "openshell policy"'
```

This rewrites `/home/agent/.claude/projects/<project>/memory/*.md` inside the workspace with a backup in `.openeral-memory-backups/` unless `--no-backup` is set.

## Prompting note

Claude's Write/Edit tools don't reliably expand `$HOME` or `~` to the sandbox's isolated home. When a prompt needs to touch files under `$HOME`, prefer `Run:` Bash commands so the shell expands the variable:

```
Run: printf "%s" "hello" > "$HOME/notes.txt" && echo WRITTEN
Run: cat "$HOME/notes.txt"
```

## Developer path (not for end users)

If the user explicitly asks to run openeral without OpenShell (e.g. for local development), point them at `BUILD.md` in the repo. The supported production path is OpenShell + the published image.
