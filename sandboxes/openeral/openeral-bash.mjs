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
const syncModulePromise = import('/opt/openeral/dist/sync.js');

async function syncFromRealFs(pool, workspaceId) {
  const { syncFromFs, createHomeSyncOptions } = await syncModulePromise;
  return syncFromFs(pool, workspaceId, HOME_DIR, createHomeSyncOptions());
}

async function syncToRealFs(pool, workspaceId) {
  const { syncToFs, createHomeSyncOptions } = await syncModulePromise;
  return syncToFs(pool, workspaceId, HOME_DIR, createHomeSyncOptions({ prune: true }));
}

function formatError(err, label) {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = err && typeof err === 'object' && 'code' in err && err.code ? ` code=${err.code}` : '';
  const detail = `${label}: ${error.message}${code}`;
  return error.stack ? `${detail}\n${error.stack}` : detail;
}

function appendStderr(stderr, detail) {
  if (!stderr) return `${detail}\n`;
  return stderr.endsWith('\n') ? `${stderr}${detail}\n` : `${stderr}\n${detail}\n`;
}

async function execCommandWithSync(shell, pool, workspaceId, command, syncWatch = null) {
  const shouldPreSync = !syncWatch || !syncWatch.isWatching() || syncWatch.isDirty();
  if (shouldPreSync) {
    try {
      await syncFromRealFs(pool, workspaceId);
      syncWatch?.markClean();
    } catch (err) {
      return {
        stdout: '',
        stderr: `${formatError(err, 'openeral-bash: syncFromFs failed')}\n`,
        exitCode: 1,
      };
    }
  }

  let result;
  let commandError = null;
  try {
    result = await shell.exec(command);
  } catch (err) {
    commandError = err;
  }

  let syncToError = null;
  try {
    if (syncWatch && syncWatch.isWatching()) {
      await syncWatch.suspend(() => syncToRealFs(pool, workspaceId));
      syncWatch.markClean();
    } else {
      await syncToRealFs(pool, workspaceId);
    }
  } catch (err) {
    syncToError = err;
  }

  if (commandError) {
    const detail = formatError(commandError, 'openeral-bash: command failed');
    const stderr = syncToError
      ? appendStderr(`${detail}\n`, formatError(syncToError, 'openeral-bash: syncToFs failed'))
      : `${detail}\n`;
    return { stdout: '', stderr, exitCode: 1 };
  }

  if (syncToError) {
    return {
      stdout: result.stdout,
      stderr: appendStderr(result.stderr, formatError(syncToError, 'openeral-bash: syncToFs failed')),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    };
  }

  return result;
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

  let syncWatch = null;
  try {
    const { watchAndSync, createHomeSyncOptions } = await syncModulePromise;
    syncWatch = watchAndSync(pool, workspaceId, HOME_DIR, createHomeSyncOptions());
  } catch (err) {
    process.stderr.write(`${formatError(err, 'openeral-bash: watcher failed')}\n`);
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

      execCommandWithSync(shell, pool, workspaceId, command, syncWatch).then((result) => {
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
    syncWatch?.stop();
    try {
      await syncFromRealFs(pool, workspaceId);
    } catch (err) {
      process.stderr.write(`${formatError(err, 'openeral-bash: shutdown syncFromFs failed')}\n`);
    }
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
