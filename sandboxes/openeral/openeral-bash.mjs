#!/usr/bin/env node

/**
 * openeral-bash — drop-in bash replacement that routes commands through
 * openeral-js (just-bash + PostgreSQL virtual filesystem).
 *
 * Two modes:
 *
 *   --daemon     Start a persistent daemon on a Unix socket. The daemon holds
 *                the openeral shell instance (PostgreSQL connection, just-bash
 *                runtime) so each command doesn't pay startup cost.
 *
 *   -c <cmd>     Execute a single command. If the daemon is running, connects
 *                to it. Otherwise, falls back to per-invocation mode (creates
 *                a fresh shell, runs the command, exits).
 *
 * Claude Code calls `bash -c '<command>'` — this script intercepts that.
 *
 * Database: uses getDatabaseConnection() which picks up external PostgreSQL
 * when DATABASE_URL is set, or starts embedded PGlite otherwise.
 */

import { createServer, createConnection } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';

const SOCKET_PATH = '/tmp/openeral-bash.sock';
const HOME_DIR = process.env.OPENERAL_HOME || '/home/agent';
const SYNC_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.openeral']);

async function syncFromRealFs(pool, workspaceId) {
  try {
    const { syncFromFs } = await import('/opt/openeral/dist/sync.js');
    await syncFromFs(pool, workspaceId, HOME_DIR, { excludeDirs: SYNC_EXCLUDE_DIRS });
  } catch (err) {
    process.stderr.write(`openeral-bash: syncFromFs warning: ${err.message}\n`);
  }
}

async function syncToRealFs(pool, workspaceId) {
  try {
    const { syncToFs } = await import('/opt/openeral/dist/sync.js');
    await syncToFs(pool, workspaceId, HOME_DIR, { excludeDirs: SYNC_EXCLUDE_DIRS });
  } catch (err) {
    process.stderr.write(`openeral-bash: syncToFs warning: ${err.message}\n`);
  }
}

async function execCommandWithSync(shell, pool, workspaceId, command) {
  await syncFromRealFs(pool, workspaceId);
  try {
    return await shell.exec(command);
  } finally {
    await syncToRealFs(pool, workspaceId);
  }
}

// ---------------------------------------------------------------------------
// Daemon mode
// ---------------------------------------------------------------------------

async function startDaemon() {
  const { createOpeneralShell } = await import('/opt/openeral/dist/shell.js');
  const { getDatabaseConnection } = await import('/opt/openeral/dist/db/embedded.js');

  const workspaceId = process.env.OPENSHELL_SANDBOX_ID || process.env.WORKSPACE_ID || 'default';

  const { pool, connectionString } = await getDatabaseConnection();

  const shell = await createOpeneralShell({
    connectionString,
    workspaceId,
    migrate: false, // setup.sh already ran migrations
    pool,
  });

  let stopWatching = () => {};
  try {
    const { watchAndSync } = await import('/opt/openeral/dist/sync.js');
    stopWatching = watchAndSync(pool, workspaceId, HOME_DIR, { excludeDirs: SYNC_EXCLUDE_DIRS });
  } catch (err) {
    process.stderr.write(`openeral-bash: watcher warning: ${err.message}\n`);
  }

  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }

  const server = createServer((conn) => {
    let data = '';

    conn.on('data', (chunk) => {
      data += chunk.toString();

      // Protocol: newline-terminated JSON request, newline-terminated JSON response
      const idx = data.indexOf('\n');
      if (idx === -1) return;

      const line = data.slice(0, idx);
      data = data.slice(idx + 1);

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        conn.end(JSON.stringify({ error: 'Invalid JSON' }) + '\n');
        return;
      }

      const command = request.command;
      if (typeof command !== 'string') {
        conn.end(JSON.stringify({ error: 'Missing command' }) + '\n');
        return;
      }

      execCommandWithSync(shell, pool, workspaceId, command).then((result) => {
        conn.end(JSON.stringify({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }) + '\n');
      }).catch((err) => {
        conn.end(JSON.stringify({
          stdout: '',
          stderr: `openeral-bash: ${err.message}\n`,
          exitCode: 1,
        }) + '\n');
      });
    });

    conn.on('error', () => {}); // ignore client disconnects
  });

  server.listen(SOCKET_PATH, () => {
    // Make socket accessible to sandbox user
    try { chmodSync(SOCKET_PATH, 0o777); } catch {}
    process.stderr.write(`openeral-bash: daemon listening on ${SOCKET_PATH}\n`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatching();
    await syncFromRealFs(pool, workspaceId);
    server.close();
    try { unlinkSync(SOCKET_PATH); } catch {}
    try { await pool.end(); } catch {}
    process.exit(0);
  }

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { void shutdown(); });
  }
}

// ---------------------------------------------------------------------------
// Client mode — connect to daemon
// ---------------------------------------------------------------------------

function execViaDaemon(command) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    let data = '';

    conn.on('connect', () => {
      conn.write(JSON.stringify({ command }) + '\n');
    });

    conn.on('data', (chunk) => {
      data += chunk.toString();
    });

    conn.on('end', () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch {
        reject(new Error('Invalid daemon response'));
      }
    });

    conn.on('error', (err) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Per-invocation fallback — create shell, run command, exit
// ---------------------------------------------------------------------------

async function execStandalone(command) {
  const { createOpeneralShell } = await import('/opt/openeral/dist/shell.js');
  const { getDatabaseConnection } = await import('/opt/openeral/dist/db/embedded.js');

  const workspaceId = process.env.OPENSHELL_SANDBOX_ID || process.env.WORKSPACE_ID || 'default';

  const { pool, connectionString } = await getDatabaseConnection();

  const shell = await createOpeneralShell({
    connectionString,
    workspaceId,
    migrate: false,
    pool,
  });

  try {
    return await execCommandWithSync(shell, pool, workspaceId, command);
  } finally {
    try { await pool.end(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Daemon mode
  if (args[0] === '--daemon') {
    await startDaemon();
    return;
  }

  // Find -c flag (how Claude Code calls bash)
  let command = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) {
      command = args[i + 1];
      break;
    }
  }

  if (!command) {
    // No -c flag — pass through to real bash for interactive use
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('/bin/bash.real', args, { stdio: 'inherit' });
    } catch (err) {
      process.exit(err.status || 1);
    }
    return;
  }

  // Try daemon first, fall back to standalone
  let result;
  try {
    result = await execViaDaemon(command);
  } catch {
    // Daemon not running — standalone mode
    result = await execStandalone(command);
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

main().catch((err) => {
  process.stderr.write(`openeral-bash: ${err.message}\n`);
  process.exit(1);
});
