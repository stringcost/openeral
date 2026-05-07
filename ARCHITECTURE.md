# Architecture

## Project Structure

```
openeral/
  crates/
    openeral/                        # Binary crate (CLI entry point)
      src/main.rs                   # Tokio main, tracing init, calls cli::run()
    openeral-core/                   # Library crate (all logic)
      migrations/                   # Refinery SQL migrations (workspace + optimization schema)
      src/
        lib.rs                      # Module declarations
        error.rs                    # FsError enum → fuser::Errno mapping
        cli/
          mod.rs                    # Cli struct, Commands enum, run()
          bootstrap.rs              # Post-FUSE OpenShell sandbox bootstrap
          memory.rs                 # Claude memory refresh under /home/agent
          optimize.rs               # Optimization metrics inspection
          mount.rs                  # Mount subcommand (pool + migrations + fuser::mount2)
          workspace.rs              # Workspace subcommands (create, mount, seed, list, delete)
          unmount.rs                # fusermount -u wrapper
          list.rs                   # Reads /proc/mounts for openeral entries
          version.rs                # Prints CARGO_PKG_VERSION
        config/
          types.rs                  # MountConfig, WorkspaceMountConfig
          connection.rs             # CLI arg > env var > ~/.openeral/config.yml
        db/
          migrate.rs                # run_migrations() + log_mount_session() via refinery
          pool.rs                   # deadpool-postgres pool (max 16, statement timeout)
          types.rs                  # SchemaInfo, TableInfo, ColumnInfo, WorkspaceFile, etc.
          queries/
            mod.rs                  # quote_ident(), get_client()
            introspection.rs        # list_schemas/tables/columns, get_primary_key
            rows.rs                 # query_rows, list_rows, get_row_data, get_all_rows_as_text
            indexes.rs              # list_indexes from pg_class/pg_index
            stats.rs                # Row count estimate + exact
            workspace.rs            # Workspace CRUD, file ops, seeding, rename
        fs/
          mod.rs                    # PgmountFilesystem (read-only, impl fuser::Filesystem)
          workspace.rs              # WorkspaceFilesystem (read-write, impl fuser::Filesystem)
          workspace_inode.rs        # Path-based inode table for workspaces
          inode.rs                  # InodeTable + NodeIdentity enum (read-only mount)
          attr.rs                   # FileAttr helpers (dir_attr, file_attr, writable_file_attr)
          cache.rs                  # MetadataCache with TTL
          nodes/                    # One file per virtual node type
            mod.rs                  # Dispatch: node_lookup/readdir/read/getattr
            root.rs                 # / → lists schemas
            schema.rs               # /public/ → lists tables
            table.rs                # /public/users/ → special dirs + page_N/ dirs
            page.rs                 # /public/users/page_1/ → rows for that page
            row.rs                  # /public/users/page_1/1/ → columns + format files
            column.rs               # column value as text file + parse_pk_display
            row_file.rs             # row.json / row.csv / row.yaml
            info.rs                 # .info/ → columns.json, schema.sql, count, primary_key
            export.rs               # .export/ → data.json/, data.csv/, data.yaml/ (paginated)
            indexes.rs              # .indexes/ → index metadata files
            filter.rs               # .filter/<col>/<val>/ → filtered rows
            order.rs                # .order/<col>/asc|desc/ → sorted rows
        format/
          json.rs                   # format_row / format_rows (smart type inference)
          csv.rs                    # CSV with headers
          yaml.rs                   # YAML via serde_yml
        mount/
          registry.rs               # MountRegistry (DashMap tracking)
      tests/
        integration.rs              # Rust integration tests
        workspace_integration.rs    # Workspace DB operations tests
  sandboxes/
    openeral/                        # OpenShell sandbox for AI agents
      Dockerfile                    # Multi-stage: build openeral + extend upstream base sandbox
      policy.yaml                   # Full sandbox runtime policy copied to /etc/openshell/policy.yaml
      README.md                     # Published-image OpenShell flow and sandbox behavior
      skills/openeral-navigate/     # Agent skill for /db navigation
  tests/
    test_fuse_mount.sh              # FUSE mount integration test suite
```

## Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `fuser` | 0.17 | FUSE filesystem trait (kernel interface) |
| `tokio` | 1 | Async runtime |
| `tokio-postgres` | 0.7 | PostgreSQL async driver |
| `deadpool-postgres` | 0.14 | Connection pooling (max 16) |
| `clap` | 4 | CLI argument parsing |
| `dashmap` | 6 | Lock-free concurrent maps (inodes, caches) |
| `serde_json` | 1 | JSON serialization |
| `csv` | 1 | CSV serialization |
| `serde_yml` | 0.0.12 | YAML serialization |
| `refinery` | 0.8 | Embedded SQL migrations |
| `thiserror` | 2 | Error type derivation |
| `tracing` | 0.1 | Structured logging |
| `chrono` | 0.4 | Date/time types |
| `percent-encoding` | 2 | PK value encoding for safe directory names |
| `libc` | 0.2 | System call constants (getuid/getgid) |

## Two FUSE Filesystems

openeral has two separate `fuser::Filesystem` implementations:

### PgmountFilesystem (read-only)

Mounts database content at a path (e.g., `/db`). Generates content on-the-fly from schema introspection and row queries. Uses a `NodeIdentity` enum with 20+ variants to model every virtual node type (schemas, tables, rows, columns, filters, exports, etc.).

**FUSE callbacks:** `lookup`, `getattr`, `readdir`, `open`, `read`, `release`, `opendir`, `releasedir`

### WorkspaceFilesystem (read-write)

Mounts an opaque file store at a path (e.g., `/home/agent`). Stores and retrieves files by path from `_openeral.workspace_files`. Uses a simple path-based inode table (`String` ↔ `u64`).

**FUSE callbacks:** `lookup`, `getattr`, `setattr`, `readdir`, `open`, `read`, `write`, `flush`, `release`, `create`, `mkdir`, `unlink`, `rmdir`, `rename`, `opendir`, `releasedir`

## Database Schema

### Read-only mount tables

```
_openeral.schema_version   — migration tracking (refinery)
_openeral.mount_log        — audit log of mount sessions
_openeral.cache_hints      — persistent cache hints per schema/table
_openeral.optimization_metrics — optional optimization savings records
_openeral.api_cache        — optional optimization API cache
```

### Workspace tables

```sql
_openeral.workspace_config (
    id TEXT PRIMARY KEY,            -- workspace identifier
    display_name TEXT,
    config JSONB DEFAULT '{}',      -- {"auto_dirs": [...], "seed_files": {...}}
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)

_openeral.workspace_files (
    workspace_id TEXT REFERENCES workspace_config(id) ON DELETE CASCADE,
    path TEXT,                      -- e.g. "/.claude/memory/note.md"
    parent_path TEXT,               -- e.g. "/.claude/memory"
    name TEXT,                      -- e.g. "note.md"
    is_dir BOOLEAN,
    content BYTEA,                  -- NULL for directories
    mode INTEGER,                   -- Unix file mode (e.g. 0o100644)
    size BIGINT,
    mtime_ns BIGINT,                -- nanosecond-precision timestamps
    ctime_ns BIGINT,
    atime_ns BIGINT,
    nlink INTEGER,
    uid INTEGER,
    gid INTEGER,
    PRIMARY KEY (workspace_id, path)
)
-- Index: (workspace_id, parent_path) for fast readdir
```

## Key Design Decisions

### Sandbox policy is owned by this repo

The openeral sandbox image does not depend on the upstream base policy staying
compatible with openeral's placeholder-based auth model.

At image build time:

- `sandboxes/openeral/policy.yaml` is copied into `/etc/openshell/policy.yaml`
- the supervisor inside the sandbox reads that file as the authoritative policy

This matters because the current sandbox has to satisfy two constraints at the
same time:

1. child processes must only see placeholder provider env values such as
   `openshell:resolve:env:ANTHROPIC_API_KEY`
2. the built-in OpenShell proxy must still allow live Claude Code traffic and
   selected direct verification traffic by rewriting those placeholders at
   egress

The policy currently includes:

- `claude_code`
  - allows Claude traffic to `api.anthropic.com`
  - uses REST + TLS termination
  - rewrites `ANTHROPIC_API_KEY` into the outbound `x-api-key` header
- `openclaw_anthropic` / `openclaw_openai`
  - allows optional OpenClaw traffic through the same OpenShell proxy path
- `socket_packages`
  - allows npm reads from Socket.dev with `SOCKET_TOKEN` placeholder injection
- `stringcost`
  - allows Claude/OpenClaw traffic through a StringCost presign base URL
- `anthropic_secret_test`
  - allows `/usr/bin/curl`
  - restricts the live verification path to `GET /v1/models`
  - uses the same header-based secret-injection mechanism

This is a deliberate tradeoff:

- **pro**: the published sandbox image is self-contained and carries the exact
  policy needed for the live-tested Claude path
- **con**: policy drift from future upstream base-image changes must be managed
  explicitly in this repo

### Pagination
Rows are grouped into `page_N/` directories to bound memory usage and directory listing size. Each page contains up to `page_size` rows (default 1000). Export files are similarly paginated. Use `.filter/` for targeted access without browsing pages.

### Async bridge
`fuser` callbacks run on OS threads; database calls use `tokio-postgres` (async). Each FUSE callback uses `tokio::runtime::Handle::block_on()` to bridge the gap.

### Inode allocation (read-only mount)
Lazy and deterministic within a mount session. A `NodeIdentity` enum describes every virtual node type. An `InodeTable` backed by `DashMap` ensures the same identity always maps to the same inode number. Root = inode 1.

### Inode allocation (workspace)
Simpler path-based table. `WorkspaceInodeTable` maps `String` path ↔ `u64` inode via `DashMap`. No `NodeIdentity` enum needed since paths are the natural identity.

### File content (read-only)
`getattr` reports an estimated size (4096). On `open`, the full content is generated and cached in a file-handle map. `read` slices from this cache. If the file doesn't exist (e.g., nonexistent row), `open` returns ENOENT.

### Write-back buffering (workspace)
`open()` loads content into memory from PostgreSQL. `write()` mutates the in-memory buffer and marks it dirty. `flush()`/`release()` writes the buffer back in a single `UPDATE ... SET content=$1` query. This avoids per-`write()` DB round-trips — the kernel sends many 4KB chunks per file write.

### SQL type handling
All column values are cast to `::text` in SQL queries. This avoids Rust type-mapping issues with PostgreSQL types like NUMERIC, MONEY, or custom domains.

### PK encoding
Primary key values are percent-encoded in directory names using the `percent-encoding` crate. Characters `/`, `,`, `=`, `%` are encoded. Integer PKs appear as-is. Decoded on read via `parse_pk_display()`.

### Statement timeout
Configured via `--statement-timeout` (default 30s). Set at the PostgreSQL connection level. Prevents runaway queries from hanging the FUSE filesystem.

### Migrations
Managed by `refinery` (`embed_migrations!` macro). SQL files in `crates/openeral-core/migrations/`. Run automatically before FUSE mount; skip with `--skip-migrations`.

### OpenShell bootstrap
The patched supervisor runs `openeral bootstrap` after `/db` and `/home/agent`
mount from `/etc/fstab` and before the user command starts. The prepare phase
seeds `.claude`, writes optional Socket.dev npm config to `/tmp`, creates or
reuses StringCost presign metadata, and writes child env additions. The runtime
phase runs through the normal OpenShell process path so optional long-lived
OpenClaw gateway processes inherit network namespace and policy enforcement.

The bootstrap replaces the old just-bash setup script behavior without
reintroducing `openeral-bash`, PGlite, host wrappers, or upload-based database
credentials.

### Workspace safety deny-list
The FUSE workspace denies common credential/history paths instead of persisting
them to PostgreSQL. This preserves the just-bash branch's non-persistence
intent for paths such as `~/.ssh`, `~/.aws`, `~/.npmrc`, shell histories, and
`~/.local/share/keyrings`.

## Live Validation Reference

The current architecture was live-validated with the upstream `openshell` CLI
matched to the openeral gateway protobuf API and the openeral images. Release
CLI `0.0.36` is a known-bad pairing for the current Docker-driver gateway
source.

### mount.fuse3 invocation detection

`mount.fuse3` invokes openeral as:

```text
openeral <source> <mountpoint> -o <options>
```

The binary distinguishes that form from normal CLI subcommands in
`crates/openeral-core/src/cli/fuse_fd.rs`. Every real CLI subcommand must be
listed in `KNOWN_SUBCOMMANDS`; otherwise a command such as `openeral bootstrap`
can be misclassified as a FUSE mount source and fail with misleading database
connection errors.

The reference proof included all of the following in one flow:

1. sandbox child env exposed only the placeholder value
   `openshell:resolve:env:ANTHROPIC_API_KEY`
2. `HOME=/home/agent claude -p 'Reply with READY and nothing else.'` succeeded
3. `/home/agent` persisted `.claude*` rows into `_openeral.workspace_files`
4. a separate `curl` call to `GET /v1/models` succeeded under the same
   placeholder env using the policy-controlled secret-injection path

So the currently intended architecture is not just theoretical:

- FUSE-backed `/home/agent` persistence is live
- stock Claude Code works against the current sandbox policy
- boundary secret injection works on the Anthropic path that was validated

## Filesystem Layout (Read-Only Mount)

```
/mnt/db/
  <schema>/                              # e.g. public/
    <table>/                             # e.g. users/
      .info/
        columns.json                     # column metadata as JSON array
        schema.sql                       # approximate CREATE TABLE DDL
        count                            # exact row count
        primary_key                      # PK column name(s)
      .export/
        data.json/page_N.json            # paginated JSON export
        data.csv/page_N.csv              # paginated CSV export
        data.yaml/page_N.yaml            # paginated YAML export
      .filter/<column>/<value>/          # filtered rows (targeted query)
      .order/<column>/asc|desc/          # sorted rows
      .indexes/<index_name>              # index metadata
      page_N/
        <pk_value>/
          <column_name>                  # column value as text file
          row.json / row.csv / row.yaml  # full row in various formats
```

## NodeIdentity Enum

```
Root
Schema { name }
Table { schema, table }
SpecialDir { schema, table, kind: Info|Export|Filter|Order|Indexes|... }
PageDir { schema, table, page }
Row { schema, table, pk_display }
Column { schema, table, pk_display, column }
RowFile { schema, table, pk_display, format }
FilterDir { schema, table, stage: Root|Column{col}|Value{col,val} }
OrderDir { schema, table, stage: Root|Column{col}|Direction{col,dir} }
LimitDir { schema, table, kind: First|Last, n }
ByIndexDir { schema, table, stage: Root|Column{col}|Value{col,val} }
InfoFile { schema, table, filename }
ExportDir { schema, table, format }
ExportFile { schema, table, format }
ExportPageFile { schema, table, format, page }
IndexDir { schema, table }
IndexFile { schema, table, index_name }
ViewsDir { schema }
View { schema, view_name }
```

## Adding a New Node Type

1. Add variant(s) to `NodeIdentity` in `fs/inode.rs`
2. Create `fs/nodes/yournode.rs` with `lookup`, `readdir`, and/or `read` functions
3. Add `pub mod yournode;` to `fs/nodes/mod.rs`
4. Wire into dispatch functions in `fs/nodes/mod.rs`: `node_lookup`, `node_readdir`, `node_read`, `node_getattr`, `is_directory`
5. If it's a special dir under tables, add to `SPECIAL_DIRS` in `fs/nodes/table.rs`
6. Add tests

## Adding a New SQL Query

1. Add the function to the appropriate file in `db/queries/`
2. Use `super::get_client(pool).await?` for a connection
3. Use parameterized queries (`$1`, `$2`)
4. Use `super::quote_ident()` for dynamic identifiers
5. Cast results to `::text` for user-facing string data
6. For row-listing queries, use `query_rows()` with optional WHERE/ORDER BY
