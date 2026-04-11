#!/usr/bin/env node

/**
 * CLI commands for optimization
 */

import { hostname } from 'node:os';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrations.js';
import { getOptimizationStats, formatStats } from './metrics.js';
import { analyzeUsage, formatAnalysisReport } from './analyzer.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    console.log(`
Openeral Optimizer Commands

Usage:
  npx openeral optimize <command> [options]

Commands:
  stats                Show optimization statistics
  analyze              Analyze usage and provide recommendations
  sync                 Sync usage data from StringCost (requires STRINGCOST_API_KEY)
  test-db              Test database connection
  help                 Show this help message

Stats Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Number of days to analyze (default: 7)

Analyze Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Number of days to analyze (default: 7)
  --json               Output as JSON

Sync Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Number of days to sync (default: 7)

Note:
  Database is embedded PGlite (auto-starts, no Docker needed).
  Set DATABASE_URL to use an external PostgreSQL instead.
  The 'sync' command requires STRINGCOST_API_KEY to fetch usage data.

Examples:
  npx openeral optimize test-db
  npx openeral optimize sync
  npx openeral optimize stats
  npx openeral optimize analyze
`);
    process.exit(0);
  }

  // Parse options
  let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
  let days = 7;
  let jsonOutput = false;
  let port = 8000;
  let optimizerEnabled = true;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceId = args[++i];
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--no-optimize') {
      optimizerEnabled = false;
    }
  }

  // Proxy command doesn't need database (REMOVED - using StringCost instead)

  // Test database connection
  if (command === 'test-db') {
    const { getDatabaseConnection } = await import('../db/embedded.js');
    console.log('Testing database connection...');

    try {
      const conn = await getDatabaseConnection();
      const result = await conn.pool.query('SELECT version() AS v');
      const version = (result.rows[0] as any)?.v ?? 'unknown';
      console.log(`✅ Connected (${conn.isEmbedded ? 'embedded PGlite' : 'external PostgreSQL'})`);
      console.log(`   ${String(version).split('\n')[0]}`);
      await conn.pool.end();
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Connection failed: ${err.message}`);
      if (process.env.DATABASE_URL) {
        console.error('   Check DATABASE_URL and ensure PostgreSQL is running.');
      } else {
        console.error('   Embedded PGlite failed to start. Try setting OPENERAL_DATA_DIR.');
      }
      process.exit(1);
    }
  }

  // Get database — embedded PGlite (default) or external via DATABASE_URL
  let pool: import('pg').Pool;
  let isEmbedded = false;

  try {
    const { getDatabaseConnection } = await import('../db/embedded.js');
    const dbConn = await getDatabaseConnection();
    pool = dbConn.pool;
    isEmbedded = dbConn.isEmbedded;

    if (isEmbedded) {
      console.log('ℹ️  Using embedded PGlite (no server required)');
    }
  } catch (err: any) {
    console.error(`❌ Database connection failed: ${err.message}`);
    if (process.env.DATABASE_URL) {
      console.error('   Check DATABASE_URL and ensure PostgreSQL is running.');
    } else {
      console.error('   Embedded PGlite failed. Try setting OPENERAL_DATA_DIR.');
    }
    process.exit(1);
  }

  try {
    await runMigrations(pool);

    if (command === 'stats') {
      const stats = await getOptimizationStats(pool, workspaceId, days);
      console.log(formatStats(stats));
    } else if (command === 'analyze') {
      const report = await analyzeUsage(pool, workspaceId, days);
      
      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatAnalysisReport(report));
      }
    } else if (command === 'sync') {
      const apiKey = process.env.STRINGCOST_API_KEY;
      if (!apiKey) {
        console.error('❌ STRINGCOST_API_KEY is required for sync');
        console.error('   export STRINGCOST_API_KEY="sk-stringcost-..."');
        console.error('\nStringCost tracks API usage and costs automatically.');
        console.error('Get your API key at: https://stringcost.com');
        process.exit(1);
      }

      // Look up the session URL saved during the last `npx openeral` run.
      // The JWT in the URL encodes the session ID so we can scope the query.
      let sessionId: string | undefined;
      let clientId: string | undefined;

      try {
        const { decodePresignUrl } = await import('./stringcost-api.js');
        const configResult = await pool.query(
          `SELECT config FROM _openeral.workspace_config WHERE id = $1`,
          [workspaceId],
        );
        const config = configResult.rows[0]?.config as Record<string, string> | undefined;
        if (config?.stringcost_session_url) {
          const decoded = decodePresignUrl(config.stringcost_session_url);
          sessionId = decoded.sessionId;
          clientId = decoded.clientId;
        }
      } catch {
        // No stored session — will fall back to account-wide event fetch
      }

      console.log(`📥 Fetching usage data from StringCost (last ${days} days)...`);
      if (sessionId) {
        console.log(`   Session ID: ${sessionId.slice(0, 8)}...`);
      } else {
        console.log(`   (no session ID stored — fetching all account events)`);
      }

      const { syncStringCostData } = await import('./stringcost-api.js');
      const result = await syncStringCostData(pool, workspaceId, apiKey, {
        sessionId,
        clientId,
        daysBack: days,
      });

      console.log(`\n✅ Sync complete!`);
      console.log(`   Fetched: ${result.fetched} events`);
      console.log(`   Stored: ${result.stored} new records`);
      console.log(`\nRun 'npx openeral optimize stats' to see your usage`);
    } else {
      console.error(`Unknown command: ${command}`);
      console.error('Run "npx openeral optimize help" for usage');
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
