import type { DbPool } from './pool.js';

/**
 * Run all database migrations (V1-V5) in order.
 *
 * Uses an advisory lock to serialize concurrent callers — two shells
 * starting at the same time on a fresh database won't race on CREATE SCHEMA.
 *
 * Uses IF NOT EXISTS / CREATE TABLE IF NOT EXISTS for idempotency.
 * Safe to call multiple times -- already-existing objects are skipped.
 */
export async function runMigrations(pool: DbPool): Promise<void> {
  const client = await pool.connect();
  try {
    // Set a statement timeout to prevent indefinite hangs
    await client.query('SET statement_timeout = 30000'); // 30 seconds

    // Acquire an advisory lock (key 0x4F50454E = 'OPEN' in hex) to serialize
    // concurrent migration attempts. Without this, two shells hitting a fresh
    // database race on CREATE SCHEMA and one fails with duplicate key.
    // pg_advisory_lock blocks until the lock is free; the 30-second
    // statement_timeout set above caps the wait so we never hang forever.
    await client.query(`SELECT pg_advisory_lock(1330795854)`);

    try {
      // V1: Create _openeral schema and schema_version table
      await client.query(`CREATE SCHEMA IF NOT EXISTS _openeral`);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // V2: Create mount_log table
      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.mount_log (
            id SERIAL PRIMARY KEY,
            mounted_at TIMESTAMPTZ DEFAULT NOW(),
            mount_point TEXT NOT NULL,
            schemas_filter TEXT[],
            page_size INTEGER,
            openeral_version TEXT
        )
      `);

      // V3: Create cache_hints table
      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.cache_hints (
            id SERIAL PRIMARY KEY,
            schema_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            hint_type TEXT NOT NULL,
            hint_value TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (schema_name, table_name, hint_type)
        )
      `);

      // V4: Create workspace_config, workspace_files, and index
      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.workspace_config (
            id TEXT PRIMARY KEY,
            display_name TEXT,
            config JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.workspace_files (
            workspace_id TEXT NOT NULL REFERENCES _openeral.workspace_config(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            parent_path TEXT NOT NULL,
            name TEXT NOT NULL,
            is_dir BOOLEAN NOT NULL DEFAULT false,
            content BYTEA,
            mode INTEGER NOT NULL DEFAULT 33188,
            size BIGINT NOT NULL DEFAULT 0,
            mtime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            ctime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            atime_ns BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1e9)::BIGINT,
            nlink INTEGER NOT NULL DEFAULT 1,
            uid INTEGER NOT NULL DEFAULT 1000,
            gid INTEGER NOT NULL DEFAULT 1000,
            PRIMARY KEY (workspace_id, path)
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ws_files_parent
            ON _openeral.workspace_files (workspace_id, parent_path)
      `);

      // V5: Create optimization tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.optimization_metrics (
            id BIGSERIAL PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            original_model TEXT NOT NULL,
            original_prompt_tokens INTEGER NOT NULL,
            original_estimated_cost DECIMAL(10, 6) NOT NULL,
            optimized_model TEXT NOT NULL,
            optimized_prompt_tokens INTEGER NOT NULL,
            optimized_actual_cost DECIMAL(10, 6) NOT NULL,
            optimizations_applied TEXT[] NOT NULL,
            task_type TEXT NOT NULL,
            cache_hit BOOLEAN NOT NULL DEFAULT false,
            tokens_saved INTEGER NOT NULL,
            cost_saved DECIMAL(10, 6) NOT NULL,
            savings_percentage DECIMAL(5, 2) NOT NULL,
            metadata JSONB
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_optimization_metrics_workspace
            ON _openeral.optimization_metrics (workspace_id, timestamp DESC)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_optimization_metrics_model
            ON _openeral.optimization_metrics (optimized_model, timestamp DESC)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS _openeral.api_cache (
            key TEXT PRIMARY KEY,
            response JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_api_cache_created
            ON _openeral.api_cache (created_at)
      `);

      // V6: grant read access to Supabase's built-in dashboard/API roles so
      // `_openeral.*` rows are visible in the Table Editor and via PostgREST.
      // On non-Supabase PostgreSQL these roles don't exist; the GRANT fails
      // with `role "..." does not exist` and we ignore it — strictly a
      // visibility fix for Supabase-hosted databases.
      for (const role of ['service_role', 'dashboard_user', 'authenticated', 'anon']) {
        try {
          await client.query(`GRANT USAGE ON SCHEMA _openeral TO ${role}`);
        } catch (err) {
          if ((err as { code?: string }).code !== '42704') throw err; // undefined_object
        }
      }
      for (const role of ['service_role', 'dashboard_user']) {
        try {
          await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA _openeral TO ${role}`);
          await client.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA _openeral GRANT SELECT ON TABLES TO ${role}`,
          );
        } catch (err) {
          if ((err as { code?: string }).code !== '42704') throw err;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(1330795854)`);
    }
  } finally {
    client.release();
  }
}
