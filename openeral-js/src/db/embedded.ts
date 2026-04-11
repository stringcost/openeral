/**
 * Database connection — embedded PGlite or external PostgreSQL.
 *
 * Priority:
 *   1. DATABASE_URL env var is set  →  external PostgreSQL (backward compat / CI)
 *   2. No DATABASE_URL              →  embedded PGlite  (auto-start, no Docker needed)
 *
 * PGlite is a WASM build of PostgreSQL that runs fully in-process.
 * No Docker, no server process, no runtime binary downloads.
 * Data is persisted to disk at OPENERAL_DATA_DIR (default: ~/.openeral/data).
 */

import { PGlite } from '@electric-sql/pglite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createPool } from './pool.js';
import type { DbPool } from './pool.js';

/** Default data directory (persists across sessions). */
const DEFAULT_DATA_DIR = join(homedir(), '.openeral', 'data');

// Singleton — one PGlite instance per Node process.
let _db: PGlite | null = null;

/**
 * Wrap a PGlite instance in a pg.Pool-compatible adapter.
 *
 * Only the methods actually used in this codebase are implemented:
 *   pool.query(text, values)
 *   pool.connect() → { query, release }
 *   pool.end()
 */
function buildPGlitePool(db: PGlite): DbPool {
  const adapter = {
    async query(text: string, values?: unknown[]) {
      return db.query(text, values as any[]);
    },

    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          return db.query(text, values as any[]);
        },
        release() {
          // PGlite is single-connection — nothing to release.
        },
      };
    },

    async end() {
      if (_db === db) {
        await db.close();
        _db = null;
      }
    },
  };

  // Cast: our adapter satisfies every method the codebase calls on DbPool.
  return adapter as unknown as DbPool;
}

/**
 * Get a database pool.
 *
 * - With DATABASE_URL: opens a real pg.Pool (external PostgreSQL).
 * - Without DATABASE_URL: starts embedded PGlite (no server required).
 */
export async function getDatabaseConnection(): Promise<{
  pool: DbPool;
  connectionString: string;
  isEmbedded: boolean;
}> {
  // ── External PostgreSQL ────────────────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    const pool = createPool(process.env.DATABASE_URL);
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return {
      pool,
      connectionString: process.env.DATABASE_URL,
      isEmbedded: false,
    };
  }

  // ── Embedded PGlite ────────────────────────────────────────────────────────
  if (!_db) {
    const dataDir = process.env.OPENERAL_DATA_DIR ?? DEFAULT_DATA_DIR;
    mkdirSync(dataDir, { recursive: true });

    _db = new PGlite(dataDir);

    // PGlite v0.x initialises asynchronously; wait until ready.
    const maybeReady = (_db as any).waitReady as Promise<void> | undefined;
    if (maybeReady) await maybeReady;
  }

  const dataDir = process.env.OPENERAL_DATA_DIR ?? DEFAULT_DATA_DIR;
  return {
    pool: buildPGlitePool(_db),
    connectionString: `pglite://${dataDir}`,
    isEmbedded: true,
  };
}

/**
 * Gracefully close the embedded PGlite instance.
 * No-op when using external PostgreSQL.
 */
export async function stopEmbeddedDatabase(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}
