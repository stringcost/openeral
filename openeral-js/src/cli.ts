#!/usr/bin/env node

/**
 * openeral CLI — run Claude Code with persistent PostgreSQL-backed home.
 *
 * Usage:
 *   npx openeral                      # interactive Claude Code
 *   npx openeral -- -p 'hello'        # non-interactive
 *   npx openeral --workspace myid     # custom workspace ID
 *   npx openeral optimize stats       # show optimization stats
 *
 * Required env:
 *   ANTHROPIC_API_KEY     Claude API key
 *
 * Optional env:
 *   DATABASE_URL              PostgreSQL connection (default: localhost:5432)
 *   OPENERAL_WORKSPACE_ID     Workspace ID (default: hostname)
 *   OPENERAL_HOME             Home directory path (default: /tmp/openeral-<id>)
 *
 * Docker PostgreSQL:
 *   docker run -d --name openeral-postgres \
 *     -e POSTGRES_USER=openeral \
 *     -e POSTGRES_PASSWORD=openeral \
 *     -e POSTGRES_DB=openeral \
 *     -p 5432:5432 \
 *     -v openeral-data:/var/lib/postgresql/data \
 *     postgres:16-alpine
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function writePgHelper(path: string): void {
  // pg helper reads DATABASE_URL from the environment at runtime.
  // Never hardcode credentials — rely on env propagation from OpenShell providers.
  const script = `#!/bin/bash
# pg — query the database from Claude Code
# Usage: pg "SELECT * FROM public.users LIMIT 5"
if [ -z "$DATABASE_URL" ]; then
  echo "pg: DATABASE_URL is not set" >&2; exit 1
fi
if command -v psql >/dev/null 2>&1; then
  exec psql "$DATABASE_URL" -c "$*"
else
  exec node -e 'const p=require("pg"),o=new p.Pool({connectionString:process.env.DATABASE_URL});o.query(process.argv[1]).then(r=>{console.log(JSON.stringify(r.rows,null,2));o.end()}).catch(e=>{console.error(e.message);process.exit(1)})' "$*"
fi
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}
import { hostname } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './db/migrations.js';
import { syncToFs, syncFromFs, watchAndSync } from './sync.js';

type ParsedArgs = 
  | { kind: 'launch'; workspaceId: string; claudeArgs: string[] }
  | { kind: 'memory-refresh'; workspaceId: string; projectRoot: string; query: string; dryRun: boolean; backup: boolean }
  | { kind: 'help' };

export function parseCliArgs(args: string[]): ParsedArgs {
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    // Only show help if it's before --
    const dashIdx = args.indexOf('--');
    const helpIdx = Math.max(args.indexOf('--help'), args.indexOf('-h'));
    if (dashIdx === -1 || helpIdx < dashIdx) {
      return { kind: 'help' };
    }
  }

  // Check for memory refresh command
  if (args[0] === 'memory' && args[1] === 'refresh') {
    let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
    let projectRoot = '';
    let query = '';
    let dryRun = false;
    let backup = true;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '--workspace' || args[i] === '-w') && args[i + 1]) {
        workspaceId = args[++i];
      } else if (args[i] === '--project-root' && args[i + 1]) {
        projectRoot = args[++i];
      } else if (args[i] === '--query' && args[i + 1]) {
        query = args[++i];
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      } else if (args[i] === '--no-backup') {
        backup = false;
      }
    }

    return { kind: 'memory-refresh', workspaceId, projectRoot, query, dryRun, backup };
  }

  // Default: launch mode
  let workspaceId = process.env.OPENERAL_WORKSPACE_ID || hostname();
  let claudeArgs: string[] = [];

  // Split on -- to separate openeral args from claude args
  const dashIdx = args.indexOf('--');
  const ownArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  claudeArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    if ((ownArgs[i] === '--workspace' || ownArgs[i] === '-w') && ownArgs[i + 1]) {
      workspaceId = ownArgs[++i];
    }
  }

  return { kind: 'launch', workspaceId, claudeArgs };
}

function printHelp(): void {
  console.log(`Usage:
  openeral [options] [-- claude-args]    Launch Claude Code with persistent home
  openeral memory refresh [options]      Refresh memory system

Launch Options:
  --workspace, -w <id>    Workspace ID (default: hostname)
  --help, -h              Show this help

Memory Refresh Options:
  --workspace, -w <id>    Workspace ID
  --project-root <path>   Project root directory
  --query <text>          Search query
  --dry-run               Preview changes without applying
  --no-backup             Skip backup creation

Environment Variables:
  ANTHROPIC_API_KEY       Claude API key (required)
  OPENERAL_WORKSPACE_ID   Default workspace ID
  OPENERAL_HOME           Home directory path
  OPENERAL_DATA_DIR       Embedded DB data path (default: ~/.openeral/data)
  DATABASE_URL            Use external PostgreSQL instead of embedded DB
  STRINGCOST_API_KEY      Track API costs via StringCost proxy
`);
}

export async function main() {
  const args = process.argv.slice(2);
  
  // Check for optimize subcommand
  if (args[0] === 'optimize') {
    // Delegate to optimize CLI
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));
    
    const child = spawn('node', [
      optimizeCliPath,
      ...args.slice(1)
    ], { stdio: 'inherit' });
    
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  
  const parsed = parseCliArgs(args);

  if (parsed.kind === 'help') {
    printHelp();
    return;
  }

  if (parsed.kind === 'memory-refresh') {
    process.stderr.write('\x1b[31mopeneral: memory refresh not yet implemented\x1b[0m\n');
    process.exit(1);
  }

  // Launch mode
  const { workspaceId, claudeArgs } = parsed;

  // --- Validate env ---
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      '\x1b[33mopeneral: ANTHROPIC_API_KEY not set — Claude Code may not work\x1b[0m\n',
    );
  }

  // --- Setup home directory ---
  const homeDir = process.env.OPENERAL_HOME || `/tmp/openeral-${workspaceId}`;
  mkdirSync(homeDir, { recursive: true });

  process.stderr.write(`\x1b[2mopeneral: workspace  ${workspaceId}\x1b[0m\n`);
  process.stderr.write(`\x1b[2mopeneral: home       ${homeDir}\x1b[0m\n`);

  // --- Database setup (embedded PGlite or external via DATABASE_URL) ---
  let pool: import('pg').Pool | null = null;
  let stopWatch: (() => void) | null = null;
  let dbConnectionString: string | undefined;
  let isEmbedded = false;

  try {
    const { getDatabaseConnection } = await import('./db/embedded.js');
    const dbConn = await getDatabaseConnection();
    pool = dbConn.pool;
    dbConnectionString = dbConn.connectionString;
    isEmbedded = dbConn.isEmbedded;

    if (isEmbedded) {
      const dataDir = process.env.OPENERAL_DATA_DIR
        ?? `${process.env.HOME ?? '~'}/.openeral/data`;
      process.stderr.write(`\x1b[2mopeneral: database   embedded PGlite (${dataDir})\x1b[0m\n`);
    } else {
      process.stderr.write('\x1b[2mopeneral: database   external PostgreSQL\x1b[0m\n');
    }

    process.stderr.write('\x1b[2mopeneral: running migrations...\x1b[0m\n');
    await runMigrations(pool);
  } catch (err: any) {
    process.stderr.write(`\x1b[31mopeneral: ${err.message}\x1b[0m\n`);
    process.exit(1);
  }

  if (pool) {

    // Ensure workspace config exists
    await pool.query(
      `INSERT INTO _openeral.workspace_config (id, display_name, config)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, workspaceId],
    );

    // Sync from PostgreSQL → filesystem
    process.stderr.write('\x1b[2mopeneral: syncing workspace...\x1b[0m\n');
    const synced = await syncToFs(pool, workspaceId, homeDir);
    process.stderr.write(`\x1b[2mopeneral: restored ${synced} files\x1b[0m\n`);

    // Write pg helper
    const pgHelper = join(homeDir, '.local', 'bin', 'pg');
    mkdirSync(join(homeDir, '.local', 'bin'), { recursive: true });
    writePgHelper(pgHelper);

    // Write CLAUDE.md
    const claudeMdPath = join(homeDir, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, `# OpenEral

Your home directory persists across sessions.

## Database

Query the connected database:

    pg "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    pg "SELECT * FROM public.users LIMIT 5"
    pg "\\d public.users"

The \`pg\` command uses psql if available, otherwise Node.js pg.

## Cost Analysis

With StringCost enabled, you can analyze your API usage:

    npx openeral optimize sync      # Fetch data from StringCost
    npx openeral optimize stats     # View statistics
    npx openeral optimize analyze   # Get recommendations

StringCost tracks all API calls automatically.
`);
    }

    // Start file watcher
    process.stderr.write('\x1b[2mopeneral: watching for changes...\x1b[0m\n');
    stopWatch = watchAndSync(pool, workspaceId, homeDir);
  }

  // Build Claude environment from allowlist to avoid exposing unnecessary secrets
  const claudeEnv: Record<string, string | undefined> = {
    HOME: homeDir,
    PATH: `${join(homeDir, '.local', 'bin')}:${process.env.PATH}`,
    // Include required ANTHROPIC_* variables for Claude Code
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    // Pass workspace ID
    OPENERAL_WORKSPACE_ID: workspaceId,
  };

  // --- Determine upstream Anthropic URL ---
  // Default: direct Anthropic. If StringCost is configured, use its proxy URL
  // so that both StringCost tracking and local DB tracking work together.
  let upstreamBaseUrl = 'https://api.anthropic.com';

  if (process.env.STRINGCOST_API_KEY && process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('\x1b[2mopeneral: presigning with StringCost...\x1b[0m\n');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch('https://app.stringcost.com/v1/presign', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRINGCOST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'anthropic',
          client_api_key: process.env.ANTHROPIC_API_KEY,
          path: ['/v1/messages'],
          expires_in: -1,
          max_uses: -1,
          tags: ['openeral'],
          metadata: { source: 'openeral' },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json() as { url?: string };
        if (data.url) {
          upstreamBaseUrl = data.url.replace(/\/v1\/.*$/, '');
          process.stderr.write('\x1b[2mopeneral: StringCost enabled — costs tracked via StringCost + local DB\x1b[0m\n');

          // Save the presign session URL so `npx openeral optimize sync` can
          // still decode the JWT and query token-usage data from StringCost.
          if (pool) {
            try {
              await pool.query(
                `UPDATE _openeral.workspace_config
                 SET config = config || $2::jsonb, updated_at = NOW()
                 WHERE id = $1`,
                [
                  workspaceId,
                  JSON.stringify({
                    stringcost_session_url: data.url,
                    stringcost_session_started: new Date().toISOString(),
                  }),
                ],
              );
            } catch {
              // Non-critical
            }
          }
        }
      }
    } catch (err: any) {
      process.stderr.write(`\x1b[33mopeneral: StringCost presign failed: ${err.message}\x1b[0m\n`);
    }
  }

  // --- Start local optimizer proxy ---
  // The proxy intercepts every /v1/messages call, saves token usage to the
  // local DB immediately, then forwards to the upstream URL. This means
  // `npx openeral optimize stats` always has live data — no API sync needed.
  let proxyServer: import('./optimize/proxy.js').OptimizerProxy | null = null;
  const sessionId = randomUUID();

  if (pool && process.env.ANTHROPIC_API_KEY) {
    try {
      const { OptimizerProxy } = await import('./optimize/proxy.js');
      proxyServer = new OptimizerProxy({
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        anthropicBaseUrl: upstreamBaseUrl,
        pool,
        workspaceId,
        sessionId,
      });
      await proxyServer.start();
      // Route Claude Code through the local proxy
      claudeEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyServer.port}`;
      process.stderr.write(`\x1b[2mopeneral: optimizer proxy active (port ${proxyServer.port}) — usage saved to DB\x1b[0m\n`);
    } catch (err: any) {
      process.stderr.write(`\x1b[33mopeneral: proxy start failed (${err.message}) — usage tracking disabled\x1b[0m\n`);
      proxyServer = null;
    }
  }

  // --- Launch Claude Code ---
  process.stderr.write('\x1b[2mopeneral: starting Claude Code\x1b[0m\n\n');

  const child = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: claudeEnv,
  });

  child.on('error', (err: any) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        '\x1b[31mopeneral: `claude` not found. Install Claude Code:\x1b[0m\n' +
        '  npm install -g @anthropic-ai/claude-code\n' +
        '  # or: curl -fsSL https://claude.ai/install.sh | bash\n\n',
      );
    } else {
      process.stderr.write(`openeral: ${err.message}\n`);
    }
    process.exit(1);
  });

  child.on('exit', async (code) => {
    // Drain pending DB writes and close proxy BEFORE ending the pool.
    // This prevents PGlite from aborting in-flight storeMetrics() calls.
    if (proxyServer) await proxyServer.drain();
    if (pool && stopWatch) {
      stopWatch();
      process.stderr.write('\n\x1b[2mopeneral: saving workspace...\x1b[0m\n');
      try {
        const saved = await syncFromFs(pool, workspaceId, homeDir);
        process.stderr.write(`\x1b[2mopeneral: saved ${saved} files\x1b[0m\n`);
      } catch (err: any) {
        process.stderr.write(`\x1b[31mopeneral: sync failed: ${err.message}\x1b[0m\n`);
      }
      await pool.end();
    }
    process.exit(code ?? 0);
  });

  // Forward signals to child
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig));
  }
}
