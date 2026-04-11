/**
 * Test database connection
 */

import { createPool } from './pool.js';

export async function testConnection(connectionString: string): Promise<{
  success: boolean;
  error?: string;
  latency?: number;
}> {
  const pool = createPool(connectionString);
  const start = Date.now();
  
  try {
    // Set a short timeout for connection test
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      const latency = Date.now() - start;
      return { success: true, latency };
    } finally {
      client.release();
    }
  } catch (err: any) {
    return { 
      success: false, 
      error: err.message,
      latency: Date.now() - start
    };
  } finally {
    await pool.end();
  }
}

/**
 * CLI to test database connection
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('Testing database connection...');
  console.log(`URL: ${connectionString.replace(/:[^:@]+@/, ':****@')}`); // Hide password
  
  testConnection(connectionString).then(result => {
    if (result.success) {
      console.log(`✅ Connection successful (${result.latency}ms)`);
      process.exit(0);
    } else {
      console.error(`❌ Connection failed: ${result.error}`);
      console.error(`   Took ${result.latency}ms before timeout`);
      process.exit(1);
    }
  });
}
