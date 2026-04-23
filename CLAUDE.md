# CLAUDE.md

## Documentation layout

- `README.md` — **end-user** docs. Uses ONLY `openshell sandbox create ...` with the published GHCR image. No `npx`, no `pnpm`, no clone steps. This is the supported path for anyone who wants to run OpenEral.
- `BUILD.md` — **contributor / developer** docs. All `npx openeral`, `pnpm`, `docker build`, and test-suite commands live here.
- `CLAUDE.md` (this file) — conventions for modifying the codebase.

When editing user docs, **never add `npx`/`pnpm`/`npm install` commands to `README.md`** — those belong in `BUILD.md`.

## Build & Test

```bash
cd openeral-js
pnpm install && pnpm build
pnpm check                    # typecheck + 30 lints + 117 unit tests

# Integration (requires PostgreSQL)
DATABASE_URL='...' node test-integration.mjs

# Docker image verification (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_sandbox_e2e.sh

# Setup.sh flow inside container (requires Docker + PostgreSQL)
DATABASE_URL='...' bash ../tests/test_setup_e2e.sh

# Real Claude Code persistence (requires PostgreSQL + ANTHROPIC_API_KEY)
DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash ../tests/test_claude_e2e.sh
```

## Project Structure

- `openeral-js/` — TypeScript package
  - `src/bin/openeral.ts` — executable wrapper for npm/npx and scripts
  - `src/cli.ts` — CLI parsing and command dispatch
  - `src/sync.ts` — PostgreSQL ↔ real filesystem sync
  - `src/pg-fs/` — PgFs: read-only IFileSystem backed by SQL queries
  - `src/workspace-fs/` — WorkspaceFs: read-write IFileSystem backed by workspace_files
  - `src/db/` — SQL queries, migrations, pool, types
  - `src/safety.ts` — command safety analysis via just-bash parse() AST
  - `src/shell.ts` — createOpeneralShell(), createToolHandler()
  - `src/index.ts` — public API
  - `lint.mjs` — 30 structural lint rules
- `sandboxes/openeral/` — OpenShell sandbox image (stock base, no FUSE)
  - `Dockerfile` — Node.js + openeral-js on stock OpenShell base
  - `openeral-bash.mjs` — daemon/client bridge for custom agents
  - `setup.sh` — sandbox entry point
  - `policy.yaml` — network policy
- `crates/` — original Rust implementation (reference, not used)

## Conventions

- Persistence is optional — CLI works without DATABASE_URL (local-only mode)
- IFileSystem implementations are path-based (no inodes)
- `parsePath()` returns a `PgNode` discriminated union
- SQL queries use `quoteIdent()` for identifiers, `$N` params for values, `::text` casts
- PgFs throws EROFS on all write methods
- WorkspaceFs receives complete content per writeFile() — no write-back buffering
- Command safety: just-bash parse() AST walk with regex fallback
- `pg` command: SQL with parens or quotes must be double-quoted

## Hard Rules

- **Never fix forward from the middle.** Stop and restart the flow from scratch.
- **Never delete, move, or overwrite user files without explicit permission.**
- **If a file appears risky, stop and ask first.**
- **Never hardcode credentials, connection strings, or secrets into files.** Always read from environment variables at runtime.

## Commit Style

Descriptive, imperative mood. Look at `git log --oneline` for examples.
