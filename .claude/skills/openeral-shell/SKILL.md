---
name: openeral-shell
description: Launch Claude Code in an OpenShell sandbox from the published OpenEral image. Optional PostgreSQL persistence and StringCost cost tracking.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
argument-hint: [optional: workspace ID]
---

# OpenEral Shell

Launch Claude Code inside an OpenShell sandbox, from the published image `ghcr.io/sandys/openeral/sandbox:just-bash`. No local clone or build required.

## Instructions

When this skill is invoked, execute the steps below. Do not just show documentation — run the commands.

### Step 1: Check prerequisites

```bash
which docker    || echo "MISSING docker"
which openshell || echo "MISSING openshell — install: https://github.com/NVIDIA/OpenShell-Community"
echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+(set)}"
echo "DATABASE_URL=${DATABASE_URL:+(set)}"
echo "STRINGCOST_API_KEY=${STRINGCOST_API_KEY:+(set)}"
```

- `ANTHROPIC_API_KEY` is required; if missing, stop and ask the user to `export ANTHROPIC_API_KEY='sk-ant-...'`.
- `DATABASE_URL` is optional — enables persistence across launches.
- `STRINGCOST_API_KEY` is optional — enables cost tracking.

### Step 2: Start the OpenShell gateway if it's not running

```bash
openshell gateway list 2>/dev/null | grep -q running || openshell gateway start
```

### Step 3: Build the provider list

`--auto-providers` will create any missing provider from the matching local env var. We always include `claude`; we include `db` and `stringcost` only when the user has set the corresponding env var.

```bash
PROVIDERS="--provider claude"

if [ -n "${DATABASE_URL:-}" ]; then
  PROVIDERS="$PROVIDERS --provider db"
fi

if [ -n "${STRINGCOST_API_KEY:-}" ]; then
  PROVIDERS="$PROVIDERS --provider stringcost"
fi
```

### Step 4: Create the sandbox from the published image

```bash
openshell sandbox create \
  --from ghcr.io/sandys/openeral/sandbox:just-bash \
  $PROVIDERS --auto-providers \
  -- /opt/openeral/setup.sh
```

`--auto-providers` pulls `ANTHROPIC_API_KEY`, `DATABASE_URL`, and `STRINGCOST_API_KEY` from the user's local shell and registers them as OpenShell providers. `setup.sh` inside the sandbox then runs migrations, seeds the workspace, starts the daemon, and exec's `claude`.

## What happens after launch

- Claude Code starts with `HOME` pointing to the isolated sandbox workspace.
- **Without `DATABASE_URL`**: PGlite runs in-process. Files are kept for the session, lost when the sandbox is deleted.
- **With `DATABASE_URL`**: files sync to PostgreSQL (Supabase, Neon, RDS, self-hosted). `pg "SELECT ..."` is available inside Claude's Bash tool. Workspace restores on next launch.
- **With `STRINGCOST_API_KEY`**: Claude's API calls route through StringCost. A permanent presign is created on first launch and reused on every subsequent one.

## Managing a running sandbox

```bash
openshell sandbox list                            # list sandboxes
openshell sandbox connect <name>                  # reattach to a sandbox
openshell sandbox exec <name> -- <cmd>            # run a command inside
openshell sandbox delete <name>                   # stop and remove
```

### Refresh Claude's memory files

From outside the sandbox:

```bash
openshell sandbox exec <name> -- node /opt/openeral/dist/bin/openeral.js memory refresh
openshell sandbox exec <name> -- node /opt/openeral/dist/bin/openeral.js memory refresh --query "openshell policy"
```

This rewrites `$HOME/.claude/projects/<project>/memory/*.md` inside the workspace with a backup in `.openeral-memory-backups/` unless `--no-backup` is set.

## Prompting note

Claude's Write/Edit tools don't reliably expand `$HOME` or `~` to the sandbox's isolated home. When a prompt needs to touch files under `$HOME`, prefer `Run:` Bash commands so the shell expands the variable:

```
Run: printf "%s" "hello" > "$HOME/notes.txt" && echo WRITTEN
Run: cat "$HOME/notes.txt"
```

## Developer path (not for end users)

If the user explicitly asks to run openeral without OpenShell (e.g. for local development), point them at `BUILD.md` in the repo. The supported production path is OpenShell + the published image.
