CREATE TABLE IF NOT EXISTS _openeral.workspace_config (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _openeral.workspace_files (
    workspace_id TEXT NOT NULL REFERENCES _openeral.workspace_config(id) ON DELETE CASCADE,
    path TEXT NOT NULL,           -- "/.claude/settings.json"
    parent_path TEXT NOT NULL,    -- "/.claude"
    name TEXT NOT NULL,           -- "settings.json"
    is_dir BOOLEAN NOT NULL DEFAULT false,
    content BYTEA,               -- NULL for directories
    mode INTEGER NOT NULL DEFAULT 33188,  -- 0o100644
    size BIGINT NOT NULL DEFAULT 0,
    mtime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
    ctime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
    atime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
    nlink INTEGER NOT NULL DEFAULT 1,
    uid INTEGER NOT NULL DEFAULT 1000,
    gid INTEGER NOT NULL DEFAULT 1000,
    PRIMARY KEY (workspace_id, path)
);

CREATE INDEX IF NOT EXISTS idx_ws_files_parent
    ON _openeral.workspace_files (workspace_id, parent_path);
