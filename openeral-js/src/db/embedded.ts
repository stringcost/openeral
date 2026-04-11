/**
 * Embedded PostgreSQL for Openeral using pg-embed
 * Auto-starts a local PostgreSQL instance if no DATABASE_URL is provided
 * 
 * NOTE: pg-embed is optional. If not installed, will fall back to requiring DATABASE_URL
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPool } from './pool.js';
import type { DbPool } from './pool.js';

const EMBEDDED_DB_DIR = join(homedir(), '.openeral', 'pgdata');
const EMBEDDED_DB_PORT = 54320; // Non-standard port to avoid conflicts
const EMBEDDED_DB_URL = `postgresql://postgres:postgres@localhost:${EMBEDDED_DB_PORT}/openeral`;

let embeddedInstance: any | null = null;
let isStarting = false;

/**
 * Start embedded PostgreSQL using pg-embed
 */
async function startEmbeddedPostgres(): Promise<any> {
  if (embeddedInstance) {
    return embeddedInstance;
  }

  if (isStarting) {
    // Wait for the other start to complete
    while (isStarting) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (embeddedInstance) {
      return embeddedInstance;
    }
  }

  isStarting = true;

  try {
    // Try to import pg-embed (optional dependency)
    let PgEmbed: any;
    try {
      // @ts-ignore - pg-embed is an optional dependency
      const module = await import('pg-embed');
      PgEmbed = module.default;
    } catch {
      throw new Error('pg-embed is not available (incompatible with Windows)');
    }

    console.log('🔧 Starting embedded PostgreSQL...');
    console.log(`   Data directory: ${EMBEDDED_DB_DIR}`);
    console.log(`   Port: ${EMBEDDED_DB_PORT}`);

    const pgEmbed = new PgEmbed({
      databaseDir: EMBEDDED_DB_DIR,
      user: 'postgres',
      password: 'postgres',
      port: EMBEDDED_DB_PORT,
      persistent: true, // Keep data between restarts
    });

    await pgEmbed.start();
    console.log('✅ Embedded PostgreSQL started');

    // Create openeral database if it doesn't exist
    try {
      const pool = createPool(`postgresql://postgres:postgres@localhost:${EMBEDDED_DB_PORT}/postgres`);
      await pool.query('CREATE DATABASE openeral');
      await pool.end();
      console.log('✅ Database "openeral" created');
    } catch (err: any) {
      if (!err.message.includes('already exists')) {
        console.warn(`⚠️  Could not create database: ${err.message}`);
      }
    }

    embeddedInstance = pgEmbed;
    isStarting = false;

    // Cleanup on process exit
    process.on('exit', () => {
      if (embeddedInstance) {
        embeddedInstance.stop().catch(() => {});
      }
    });

    process.on('SIGINT', async () => {
      if (embeddedInstance) {
        await embeddedInstance.stop();
      }
      process.exit(0);
    });

    return pgEmbed;
  } catch (err: any) {
    isStarting = false;
    throw new Error(`Failed to start embedded PostgreSQL: ${err.message}`);
  }
}

/**
 * Get database connection (embedded or external)
 */
export async function getDatabaseConnection(): Promise<{
  pool: DbPool;
  connectionString: string;
  isEmbedded: boolean;
}> {
  // If DATABASE_URL is set, use it
  if (process.env.DATABASE_URL) {
    try {
      const pool = createPool(process.env.DATABASE_URL);
      // Test connection
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      return {
        pool,
        connectionString: process.env.DATABASE_URL,
        isEmbedded: false,
      };
    } catch (err: any) {
      console.warn(`⚠️  Could not connect to DATABASE_URL: ${err.message}`);
      console.log('   Falling back to embedded PostgreSQL...');
    }
  }

  // Try to use embedded PostgreSQL
  try {
    await startEmbeddedPostgres();
    const pool = createPool(EMBEDDED_DB_URL);
    
    return {
      pool,
      connectionString: EMBEDDED_DB_URL,
      isEmbedded: true,
    };
  } catch (err: any) {
    // If embedded fails, throw a helpful error
    throw new Error(
      'No database available.\n' +
      '  pg-embed is not compatible with Windows.\n' +
      '  Please set DATABASE_URL environment variable to use an external PostgreSQL database.'
    );
  }
}

/**
 * Stop embedded PostgreSQL
 */
export async function stopEmbeddedDatabase(): Promise<void> {
  if (embeddedInstance) {
    console.log('🛑 Stopping embedded PostgreSQL...');
    await embeddedInstance.stop();
    embeddedInstance = null;
  }
}

