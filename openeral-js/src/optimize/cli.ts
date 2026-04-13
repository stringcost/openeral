#!/usr/bin/env node

/**
 * CLI commands for optimization
 */

import { hostname } from 'node:os';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrations.js';
import { getOptimizationStats, formatStats } from './metrics.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    console.log(`
Openeral Optimizer Commands

Usage:
  npx openeral optimize <command> [options]

Commands:
  stats                Show API call statistics (costs, tokens, cache hits)
  analyze              Analyze session history and propose changes to reduce future token usage
  apply                Apply proposals from analyze (patches CLAUDE.md, creates context file, etc.)
  test-db              Test database connection
  help                 Show this help message

Stats Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Number of days to analyze (default: 7)

Analyze / Apply Options:
  --workspace <id>     Workspace ID (default: hostname)
  --days <n>           Days of session history to analyze (default: 7)
  --project-root <p>   Project root directory (default: auto-detect from cwd)
  --dry-run            Preview changes without writing files (apply only)
  --proposal <id>      Apply a specific proposal by ID (apply only; omit = apply all)
  --json               Output as JSON (analyze only)

Proposal IDs:
  model-routing        Add model selection rules to CLAUDE.md
  context-file         Create .claude/CONTEXT.md + add read/update instruction
  readme-updates       Add README maintenance instruction to CLAUDE.md
  lazy-reading         Add file reading efficiency rules to CLAUDE.md
  memory-compact       Strip code blocks and duplicates from memory files

Note:
  Database is embedded PGlite (auto-starts, no Docker needed).
  Set DATABASE_URL to use an external PostgreSQL instead.
  Run sessions via 'npx openeral' first so analyze has usage data.

Examples:
  npx openeral optimize analyze
  npx openeral optimize apply
  npx openeral optimize apply --dry-run
  npx openeral optimize apply --proposal model-routing
  npx openeral optimize apply --proposal context-file
`);
    process.exit(0);
  }

  // Parse options
  let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
  let days = 7;
  let jsonOutput = false;
  let dryRun = false;
  let projectRoot = '';
  const proposalIds: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceId = args[++i];
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[++i], 10);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = args[++i];
    } else if (args[i] === '--proposal' && args[i + 1]) {
      proposalIds.push(args[++i]);
    }
  }

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
      const { analyzePromptSurface, formatPromptSurfaceReport } = await import('./analyzer.js');
      const report = await analyzePromptSurface({
        pool,
        workspaceId,
        projectRoot: projectRoot || process.cwd(),
        daysBack: days,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatPromptSurfaceReport(report));
      }
    } else if (command === 'apply') {
      const { analyzePromptSurface, applyRecommendations } = await import('./analyzer.js');
      const report = await analyzePromptSurface({
        pool,
        workspaceId,
        projectRoot: projectRoot || process.cwd(),
        daysBack: days,
      });
      await applyRecommendations(report, {
        dryRun,
        proposals: proposalIds.length > 0 ? proposalIds : undefined,
      });
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
