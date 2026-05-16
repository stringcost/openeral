/**
 * Database connection — external PostgreSQL only.
 *
 * DATABASE_URL is required. Use Supabase, Neon, or any PostgreSQL instance.
 * Run `npx openeral db-url postgresql://...` to store it once.
 */

import { createPool } from './pool.js';
import type { DbPool } from './pool.js';

/**
 * Get a database pool connected to the PostgreSQL instance at DATABASE_URL.
 * Throws if DATABASE_URL is not set.
 */
export async function getDatabaseConnection(): Promise<{
  pool: DbPool;
  connectionString: string;
  isEmbedded: boolean;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required.\n' +
      'Store it once with: npx openeral db-url postgresql://user:pass@host/db\n' +
      'Or set it in your environment: export DATABASE_URL=postgresql://...',
    );
  }

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

/**
 * No-op: kept for API compatibility.
 */
export async function stopEmbeddedDatabase(): Promise<void> {
  // PostgreSQL pool is ended via pool.end() — nothing to do here.
}
