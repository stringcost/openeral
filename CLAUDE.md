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
pnpm check                    # typecheck + 29 lints + 108 unit tests

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
  - `lint.mjs` — 29 structural lint rules
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

## Agent Selection (Claude Code vs OpenClaw)

The sandbox supports two agents controlled by `OPENERAL_AGENT`:

- `claude` (default) — Claude Code. Seeds `/.claude` and `/.claude/projects`, writes StringCost proxy to `~/.claude/settings.json`, execs `claude`.
- `openclaw` — OpenClaw. Seeds `/.config` only (no `/.claude`), reads StringCost proxy from `ANTHROPIC_BASE_URL` exported at exec time, execs `openclaw`.

`OPENERAL_AGENT` is never set directly by users. It is injected into the sandbox by OpenShell's provider framework: the `openclaw` generic provider carries `--credential "OPENERAL_AGENT=openclaw"`.

The workspace schema (`_openeral`) is shared — both agents read and write the same `workspace_files` table.

### StringCost integration

Both agents route their Anthropic API calls through StringCost when a presign is available. Each agent gets its own presign with a distinct `metadata.labels` entry so the StringCost vendor portfolio can attribute usage:

- Claude Code → `metadata.labels: ['openeral', 'claude-code']`, stored at `~/.openeral/presign.json`.
- OpenClaw → `metadata.labels: ['openeral', 'openclaw']`, stored at `~/.openeral/presign-openclaw.json`.

Presigns are created against `STRINGCOST_API_BASE` (defaults to `https://app.stringcost.com`; override for local stacks). The proxy URL regex accepts both `https://proxy.stringcost.com/...` and self-hosted shapes (`http(s)://<host>/stringcost-proxy/t/...`).

When adding features that differ by agent, gate on `OPENERAL_AGENT` in `setup.sh` (bash) and `process.env.OPENERAL_AGENT` in Node.js. The StringCost presign acquisition runs for **both** agents; only the `~/.claude/settings.json` write is gated to Claude Code.

## Build & test for OpenClaw

```bash
# Verify setup.sh handles both agents (no Docker required)
bash -n sandboxes/openeral/setup.sh
grep -q 'OPENERAL_AGENT' sandboxes/openeral/setup.sh

# Full OpenClaw setup path (requires Docker + PostgreSQL)
DATABASE_URL='...' OPENERAL_AGENT=openclaw bash tests/test_setup_e2e.sh
```

## Hard Rules

- **Never fix forward from the middle.** Stop and restart the flow from scratch.
- **Never delete, move, or overwrite user files without explicit permission.**
- **If a file appears risky, stop and ask first.**
- **Never hardcode credentials, connection strings, or secrets into files.** Always read from environment variables at runtime.

## Commit Style

Descriptive, imperative mood. Look at `git log --oneline` for examples.
