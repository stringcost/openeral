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
  analyze              Analyze usage and provide recommendations (like Clawptimizer)
  sync                 Sync usage data from Anthropic API
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
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error('❌ DATABASE_URL environment variable is required');
      console.error('\nSet it like this:');
      console.error('  export DATABASE_URL="postgresql://user:pass@host:5432/dbname"');
      process.exit(1);
    }

    const { testConnection } = await import('../db/test-connection.js');
    console.log('Testing database connection...');
    console.log(`URL: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}\n`); // Hide password
    
    const result = await testConnection(databaseUrl);
    if (result.success) {
      console.log(`✅ Connection successful (${result.latency}ms)`);
      process.exit(0);
    } else {
      console.error(`❌ Connection failed: ${result.error}`);
      console.error(`   Took ${result.latency}ms before timeout\n`);
      console.error('Common issues:');
      console.error('  - Database server not running');
      console.error('  - Wrong host/port in DATABASE_URL');
      console.error('  - Firewall blocking connection');
      console.error('  - Wrong credentials');
      process.exit(1);
    }
  }

  // Validate DATABASE_URL or use embedded for other commands
  let pool: import('pg').Pool;
  let isEmbedded = false;

  try {
    const { getDatabaseConnection } = await import('../db/embedded.js');
    const dbConn = await getDatabaseConnection();
    pool = dbConn.pool;
    isEmbedded = dbConn.isEmbedded;

    if (isEmbedded) {
      console.log('ℹ️  Using embedded PostgreSQL (auto-started)');
    }
  } catch (err: any) {
    console.error(`❌ Database connection failed: ${err.message}`);
    console.error('\nTroubleshooting:');
    console.error('  1. Set DATABASE_URL to use external PostgreSQL');
    console.error('  2. Or let Openeral use embedded PostgreSQL (automatic)');
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
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('❌ ANTHROPIC_API_KEY is required for sync');
        console.error('   export ANTHROPIC_API_KEY="sk-ant-..."');
        process.exit(1);
      }

      const { syncUsageData } = await import('./anthropic-api.js');
      const result = await syncUsageData(pool, workspaceId, apiKey, days);
      
      console.log(`\n✅ Sync complete!`);
      console.log(`   Fetched: ${result.fetched} records`);
      console.log(`   Stored: ${result.stored} new records`);
      console.log(`\nRun 'npx openeral optimize analyze' to see recommendations`);
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
