# Architecture

## Overview

```
Agent ──bash tool──► openeral-bash ──► just-bash (TypeScript)
                                          │
                                     MountableFs
                                     ├── /db         → PgFs (read-only SQL)
                                     ├── /home/agent → WorkspaceFs (read-write PostgreSQL)
                                     └── /tmp        → InMemoryFs
```

For Claude Code and OpenClaw:

```
                    ┌─────────────┐
PostgreSQL ◄──sync──┤ /home/agent ├──► Claude Code  (Read, Write, Edit, Bash, ...)
                    └──────┬──────┘    OpenClaw      (same filesystem, same workspace)
                      file watcher
                           │
                    sync on change ──► PostgreSQL
```

Agent selection is controlled by the `OPENERAL_AGENT` environment variable (`claude` or `openclaw`), which is injected into the sandbox by the corresponding OpenShell provider.

## Components

### openeral-js (`openeral-js/`)

TypeScript package. Two filesystem implementations on just-bash's `IFileSystem` interface:

- **PgFs** (`src/pg-fs/`) — read-only. Parses paths into a `PgNode` discriminated union, dispatches to SQL queries. Generates content on-the-fly from live database. Caches schema metadata with TTL.
- **WorkspaceFs** (`src/workspace-fs/`) — read-write. Direct SQL CRUD against `_openeral.workspace_files`. Every write persists immediately.

Supporting modules:

- **sync** (`src/sync.ts`) — bidirectional sync between PostgreSQL and real filesystem. Used by the CLI for Claude Code, which needs real files for its Read/Write/Edit tools.
- **safety** (`src/safety.ts`) — command analysis via just-bash's `parse()` AST. Classifies commands as safe/destructive.
- **shell** (`src/shell.ts`) — `createOpeneralShell()` factory. Composes MountableFs + custom `pg` command + execution limits.
- **cli** (`src/cli.ts`) — `npx openeral` entry point. Sync + file watcher + Claude Code launcher.

### Sandbox (`sandboxes/openeral/`)

Stock OpenShell base image + Node.js + openeral-js. No custom cluster or gateway.

- **openeral-bash.mjs** — daemon/client bridge. Daemon holds a persistent just-bash shell on a Unix socket. Each `bash -c` from Claude Code or OpenClaw connects, executes, streams output.
- **setup.sh** — entry point. Migrations → seed → daemon → agent launch. Reads `OPENERAL_AGENT` (`claude` or `openclaw`) to decide which agent to exec; defaults to Claude Code. StringCost presign integration is skipped for OpenClaw.
- **policy.yaml** — network policy for the OpenShell supervisor. Includes `openclaw_install` (openclaw.ai), `openclaw_openai` (api.openai.com), and `npm_registry` GitHub release hosts required by openclaw's native module postinstall.

### Database schema (`_openeral`)

- `workspace_config` — workspace metadata (id, display_name, config JSONB)
- `workspace_files` — file content and metadata (workspace_id, path, content BYTEA, mode, size, timestamps)
- `schema_version`, `mount_log`, `cache_hints` — operational

### Legacy Rust (`crates/`)

Original FUSE implementation. Retained for reference, not used in the sandbox.
