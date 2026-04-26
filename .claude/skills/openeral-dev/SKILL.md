---
name: openeral-dev
description: Develop openeral-js — isolated home + optional PostgreSQL persistence + database access for AI agents
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
argument-hint: [task description]
---

# OpenEral Development

OpenEral gives AI agents an isolated home directory with optional PostgreSQL-backed persistence and database access. This skill is for contributors modifying the OpenEral source.

**End users should use the published GHCR image via `openshell sandbox create`** (see `README.md`). This skill's `npx`/`pnpm` commands apply only when you have the repo cloned locally — full developer setup is in `BUILD.md`.

## Key Files

```
openeral-js/src/
  bin/openeral.ts             # executable wrapper for npm/npx and scripts
  cli.ts                      # CLI parsing and command dispatch
  sync.ts                     # PostgreSQL ↔ real filesystem sync
  pg-fs/pg-fs.ts              # PgFs: read-only IFileSystem → SQL queries
  pg-fs/path-parser.ts        # parsePath() → PgNode discriminated union
  workspace-fs/workspace-fs.ts # WorkspaceFs: read-write → workspace_files table
  db/queries.ts               # All SQL (introspection, rows, stats, indexes)
  db/workspace-queries.ts     # Workspace CRUD
  db/migrations.ts            # V1-V6 schema migrations (incl. Supabase-role grants)
  db/http-connect-socket.ts   # Duplex wrapper: pg over HTTP CONNECT proxy
  safety.ts                   # Command analysis via just-bash parse() AST
  shell.ts                    # createOpeneralShell(), createToolHandler()

sandboxes/openeral/
  Dockerfile                  # Stock OpenShell base + Node.js + openeral-js
  openeral-bash.mjs           # Daemon/client bridge for pg, sync, custom agents
  openeral-claude.sh          # Claude wrapper for connected service sessions
  pg-client.mjs               # pg helper for real-bash Claude sessions
  setup.sh                    # openeral/openeral-start sandbox entry point
  policy.yaml                 # Network policy

Dockerfile.openeral           # Repo-root OpenShell local-build entrypoint
```

## Build & Verify

```bash
cd openeral-js
pnpm install && pnpm build
pnpm check                                      # typecheck + structural lints + unit tests
DATABASE_URL='...' node test-integration.mjs     # integration against live PostgreSQL
DATABASE_URL='...' node test-memory-refresh.mjs  # memory refresh persistence
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh   # Docker image verification
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh     # setup.sh flow inside container
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh  # real Claude Code via Run:/Bash writes in isolated HOME
```

To test a local build through OpenShell itself, run from the repo root:

```bash
openshell sandbox create \
  --name openeral-local-dev \
  --from Dockerfile.openeral \
  --provider claude --auto-providers \
  -- env WORKSPACE_ID=openeral-local-dev openeral-start
```

Do not use raw `--from openeral-sandbox:dev` unless that image has already been imported into the OpenShell gateway's containerd. Tag-shaped values are treated as image references by the sandbox pod. `--from Dockerfile.openeral` is the direct OpenShell local-build path.

## Structural Lints (lint.mjs — 31 rules)

Key rules: imports resolve, exports match, just-bash >=2.x, PgFs throws EROFS, no write-back buffering, no FUSE in Dockerfile, no hardcoded credentials, sync persists deletions, sync preserves modes, exclude uses exact matching, syncToFs prunes stale files, syncToFs prunes before creating, pruneLocal handles type conflicts, README includes build steps, migrations use advisory lock, skill checks node_modules, no fork-specific policy fields (secret_injection/egress_via), Socket.dev endpoint has TLS terminate, Claude policy allows `claude-real`.

## Conventions

- PgFs is read-only — all write methods throw EROFS
- WorkspaceFs receives complete content per writeFile() — no buffering
- Path parsing replaces FUSE inodes: `parsePath()` → PgNode
- SQL uses `quoteIdent()` + `$N` params + `::text` casts
- `pg` command: complex SQL must be double-quoted
- Command safety: AST walk + regex fallback
- `openeral-start` is service mode: create sandbox, connect, run `claude`, exit with `/exit` or Ctrl-D, restart with `claude -c`
- Persistence is optional — without DATABASE_URL, PGlite is scoped to the running sandbox lifetime
- For repo-local automation, prefer `node dist/bin/openeral.js` after `pnpm build`
- Real Claude persistence checks should use `Run:` Bash commands for `$HOME` paths; Claude file tools do not reliably expand shell variables inside the isolated home
- Never hardcode credentials — always read from environment at runtime

## Migrations

Auto-run in `createOpeneralShell()` and CLI. Schema: `_openeral` with tables `workspace_config`, `workspace_files`, `schema_version`, `mount_log`, `cache_hints`, `optimization_metrics`, `api_cache`. V6 grants `USAGE` + `SELECT` to Supabase roles (`service_role`, `dashboard_user`, `authenticated`, `anon`) — wrapped in try/catch on `42704` so non-Supabase PostgreSQL still runs cleanly. Must be idempotent.
