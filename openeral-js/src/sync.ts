/**
 * Bidirectional sync between PostgreSQL workspace_files and the real filesystem.
 *
 * syncToFs:    PostgreSQL → real filesystem (startup)
 * syncFromFs:  real filesystem → PostgreSQL (shutdown / on-change)
 * watchAndSync: continuous background sync via fs.watch
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, unlinkSync, rmSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import type pg from 'pg';

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Default directories to skip — exact basename matches only. */
export const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.openeral']);
export const DEFAULT_EXCLUDE_FILES = new Set<string>();
export const HOME_SYNC_EXCLUDE_DIRS = new Set([
  ...DEFAULT_EXCLUDE_DIRS,
  '.aws',
  '.azure',
  '.config',
  '.docker',
  '.gnupg',
  '.kube',
  '.npm',
  '.ssh',
]);
export const HOME_SYNC_EXCLUDE_FILES = new Set([
  '.bash_history',
  '.git-credentials',
  '.lesshst',
  '.mysql_history',
  '.netrc',
  '.npmrc',
  '.psql_history',
  '.python_history',
  '.wget-hsts',
  '.zsh_history',
]);
// Selective exclusions inside /home/agent/.openclaw — drop the noisy/ephemeral
// subtrees (logs, npm staging caches, gateway runtime state, scratch dirs) but
// keep the user-meaningful bits (openclaw.json, agents/, sessions, memory-core
// data) on the sync path so they persist across sandbox sessions.
//
// Rationale: setup.sh's plugin staging already goes to /tmp via
// OPENCLAW_PLUGIN_STAGE_DIR, and openclaw's gateway writes log/state files
// under .openclaw at high frequency during startup. Excluding just those
// subdirs gives openclaw persistent memory + sessions without re-triggering
// the watcher → walkDir → pooler-timeout cascade.
export const HOME_SYNC_EXCLUDE_PATH_PREFIXES = [
  '/.local/share/keyrings',
  '/.openclaw/logs',
  '/.openclaw/cache',
  '/.openclaw/plugin-runtime-deps',
  '/.openclaw/plugins-runtime',
  '/.openclaw/gateway',
  '/.openclaw/runtime',
  '/.openclaw/tmp',
  '/.openclaw/var',
  // Sessions hold in-progress task state from the previous sandbox run. Persisting
  // them causes OpenClaw to auto-resume those tasks on the next launch, blocking
  // new user input for the entire duration. Memory-core data (agent knowledge) is
  // kept on the sync path so the agent retains context across sessions.
  '/.openclaw/sessions',
];

export interface SyncOptions {
  excludeDirs?: Set<string>;
  excludeFiles?: Set<string>;
  excludePathPrefixes?: string[];
  prune?: boolean;
}

interface ResolvedSyncOptions {
  excludeDirs: Set<string>;
  excludeFiles: Set<string>;
  excludePathPrefixes: string[];
  prune: boolean;
}

export interface SyncWatchHandle {
  stop(): void;
  isDirty(): boolean;
  isWatching(): boolean;
  markDirty(): void;
  markClean(): void;
  suspend<T>(fn: () => Promise<T>): Promise<T>;
}

export function createHomeSyncOptions(overrides: SyncOptions = {}): SyncOptions {
  return {
    excludeDirs: new Set([...HOME_SYNC_EXCLUDE_DIRS, ...(overrides.excludeDirs ?? [])]),
    excludeFiles: new Set([...HOME_SYNC_EXCLUDE_FILES, ...(overrides.excludeFiles ?? [])]),
    excludePathPrefixes: [...HOME_SYNC_EXCLUDE_PATH_PREFIXES, ...(overrides.excludePathPrefixes ?? [])],
    prune: overrides.prune ?? false,
  };
}

function shouldExclude(name: string, excludeDirs: Set<string>): boolean {
  return excludeDirs.has(name);
}

function normalizeDbPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized || normalized === '/') return '/';
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function splitDbPath(path: string): string[] {
  return normalizeDbPath(path).split('/').filter(Boolean);
}

function hasExcludedPrefix(path: string, prefixes: string[]): boolean {
  const normalized = normalizeDbPath(path);
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function shouldExcludePath(path: string, opts: ResolvedSyncOptions, isDir?: boolean): boolean {
  if (path === '/') return false;
  if (hasExcludedPrefix(path, opts.excludePathPrefixes)) return true;

  const segments = splitDbPath(path);
  if (segments.some((segment) => shouldExclude(segment, opts.excludeDirs))) return true;

  if (isDir !== true) {
    const basename = segments[segments.length - 1];
    if (opts.excludeFiles.has(basename)) return true;
  }

  return false;
}

function normalizeSyncOptions(opts?: SyncOptions): ResolvedSyncOptions {
  return {
    excludeDirs: opts?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS,
    excludeFiles: opts?.excludeFiles ?? DEFAULT_EXCLUDE_FILES,
    excludePathPrefixes: (opts?.excludePathPrefixes ?? []).map(normalizeDbPath),
    prune: opts?.prune ?? true,
  };
}

function formatSyncError(err: unknown, label: string): string {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = err && typeof err === 'object' && 'code' in err && err.code ? ` code=${err.code}` : '';
  const detail = `${label}: ${error.message}${code}`;
  return error.stack ? `${detail}\n${error.stack}` : detail;
}

/**
 * Dump all workspace_files rows to a real directory.
 * Creates directories and writes file content, preserving stored modes.
 * Removes local files that are not in the database.
 */
export async function syncToFs(
  pool: pg.Pool,
  workspaceId: string,
  targetDir: string,
  opts?: SyncOptions,
): Promise<number> {
  const syncOpts = normalizeSyncOptions(opts);

  const { rows: allRows } = await pool.query(
    `SELECT path, is_dir, content, mode FROM _openeral.workspace_files
     WHERE workspace_id = $1 ORDER BY path`,
    [workspaceId],
  );
  const rows = allRows.filter((row: any) => !shouldExcludePath(row.path as string, syncOpts, row.is_dir as boolean));

  const dbPaths = new Set(rows.map((r: any) => r.path as string));
  const dbTypes = new Map(rows.map((r: any) => [r.path as string, r.is_dir as boolean]));
  let count = 0;

  // Step 1: Prune stale local entries AND resolve type conflicts BEFORE creating.
  // A path that changed type (file↔dir) between sessions would cause EEXIST/EISDIR
  // if we tried to create first.
  if (syncOpts.prune) {
    pruneLocal(targetDir, '/', dbPaths, dbTypes, syncOpts);
  }

  // Step 2: Create directories (sorted by path ensures parents before children)
  for (const row of rows) {
    if (!row.is_dir) continue;
    const fullPath = join(targetDir, row.path);
    mkdirSync(fullPath, { recursive: true });
    try { chmodSync(fullPath, row.mode & 0o7777); } catch {}
    count++;
  }

  // Step 3: Write files
  for (const row of rows) {
    if (row.is_dir) continue;
    const fullPath = join(targetDir, row.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    const content = row.content ?? Buffer.alloc(0);
    writeFileSync(fullPath, content);
    try { chmodSync(fullPath, row.mode & 0o7777); } catch {}
    count++;
  }

  return count;
}

/**
 * Recursively remove local entries that are either:
 * - not in dbPaths (stale leftovers), or
 * - present but with wrong type (file in DB but dir on disk, or vice versa)
 *
 * Walks bottom-up so children are removed before parents.
 */
function pruneLocal(
  baseDir: string,
  dbParent: string,
  dbPaths: Set<string>,
  dbTypes: Map<string, boolean>,
  opts: ResolvedSyncOptions,
): void {
  const fullDir = join(baseDir, dbParent);
  let entries: string[];
  try {
    entries = readdirSync(fullDir);
  } catch {
    return;
  }

  for (const name of entries) {
    const fullPath = join(fullDir, name);
    const dbPath = dbParent === '/' ? `/${name}` : `${dbParent}/${name}`;
    if (shouldExcludePath(dbPath, opts)) continue;

    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    const inDb = dbPaths.has(dbPath);
    const dbIsDir = dbTypes.get(dbPath);

    if (st.isDirectory()) {
      // Recurse first so children are cleaned before we potentially remove this dir
      pruneLocal(baseDir, dbPath, dbPaths, dbTypes, opts);

      if (!inDb) {
        // Stale directory — remove entirely
        try { rmSync(fullPath, { recursive: true }); } catch {}
      } else if (dbIsDir === false) {
        // Type conflict: local is dir but DB says file — remove dir
        try { rmSync(fullPath, { recursive: true }); } catch {}
      }
    } else {
      if (!inDb) {
        // Stale file — remove
        try { unlinkSync(fullPath); } catch {}
      } else if (dbIsDir === true) {
        // Type conflict: local is file but DB says dir — remove file
        try { unlinkSync(fullPath); } catch {}
      }
    }
  }
}

interface FileBatchRow {
  path: string;
  parentPath: string;
  name: string;
  content: Buffer;
  mode: number;
  size: number;
  mtimeNs: string;
}

interface DirBatchRow {
  path: string;
  parentPath: string;
  name: string;
  mode: number;
  mtimeNs: string;
}

// Each file row binds 7 params (path, parent_path, name, content, mode, size, mtime_ns)
// plus the shared workspace_id. Postgres has a 65_535-parameter limit per statement
// and Supabase's transaction pooler enforces an 8 s statement_timeout — flush before
// either becomes the bottleneck. Files also flush when accumulated content bytes
// exceed the byte budget so a single batch never serialises tens of megabytes.
const FILE_BATCH_ROWS = 64;
const DIR_BATCH_ROWS = 256;
const FILE_BATCH_BYTES = 4 * 1024 * 1024;

async function flushDirBatch(
  pool: pg.Pool,
  workspaceId: string,
  batch: DirBatchRow[],
): Promise<void> {
  if (batch.length === 0) return;
  const tuples: string[] = [];
  const params: unknown[] = [workspaceId];
  let p = 2;
  for (const row of batch) {
    tuples.push(
      `($1, $${p}, $${p + 1}, $${p + 2}, true, NULL, $${p + 3}, 0, $${p + 4}, $${p + 4}, $${p + 4}, 2, 1000, 1000)`,
    );
    params.push(row.path, row.parentPath, row.name, row.mode, row.mtimeNs);
    p += 5;
  }
  await pool.query(
    `INSERT INTO _openeral.workspace_files
     (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (workspace_id, path) DO UPDATE SET mode = EXCLUDED.mode, mtime_ns = EXCLUDED.mtime_ns`,
    params,
  );
  batch.length = 0;
}

async function flushFileBatch(
  pool: pg.Pool,
  workspaceId: string,
  batch: FileBatchRow[],
): Promise<void> {
  if (batch.length === 0) return;
  const tuples: string[] = [];
  const params: unknown[] = [workspaceId];
  let p = 2;
  for (const row of batch) {
    tuples.push(
      `($1, $${p}, $${p + 1}, $${p + 2}, false, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 6}, $${p + 6}, 1, 1000, 1000)`,
    );
    params.push(row.path, row.parentPath, row.name, row.content, row.mode, row.size, row.mtimeNs);
    p += 7;
  }
  await pool.query(
    `INSERT INTO _openeral.workspace_files
     (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (workspace_id, path) DO UPDATE SET content = EXCLUDED.content, mode = EXCLUDED.mode, size = EXCLUDED.size, mtime_ns = EXCLUDED.mtime_ns`,
    params,
  );
  batch.length = 0;
}

/**
 * Scan a real directory and upsert all files into workspace_files.
 * Optionally deletes DB rows for files that no longer exist on disk.
 *
 * Incremental: loads existing (path, mtime_ns, size, is_dir) once, then skips
 * the upsert for any file whose stat mtime and size match the stored row.
 * This avoids re-uploading multi-MB bytea content on every walk when nothing
 * has actually changed.
 *
 * Batched: rows are accumulated and flushed as multi-row VALUES INSERTs so a
 * full /home/agent walk runs in tens of statements rather than thousands —
 * a hard requirement when the database is behind a pooler with a statement_timeout
 * and the connection traverses a high-latency tunnel.
 */
export async function syncFromFs(
  pool: pg.Pool,
  workspaceId: string,
  sourceDir: string,
  opts?: SyncOptions,
): Promise<number> {
  const syncOpts = normalizeSyncOptions(opts);
  const seenPaths = new Set<string>(['/']);
  let count = 0;

  // Snapshot existing rows so we can short-circuit unchanged paths and prune
  // without a second SELECT pass at the end.
  const existing = new Map<string, { mtimeNs: bigint; size: bigint; isDir: boolean }>();
  {
    const { rows } = await pool.query(
      `SELECT path, mtime_ns::text AS mtime_ns, size::text AS size, is_dir
       FROM _openeral.workspace_files WHERE workspace_id = $1`,
      [workspaceId],
    );
    for (const row of rows) {
      existing.set(row.path as string, {
        mtimeNs: BigInt(row.mtime_ns as string),
        size: BigInt(row.size as string),
        isDir: row.is_dir as boolean,
      });
    }
  }

  const fileBatch: FileBatchRow[] = [];
  const dirBatch: DirBatchRow[] = [];
  let fileBatchBytes = 0;

  async function maybeFlushDirs(force = false): Promise<void> {
    if (dirBatch.length === 0) return;
    if (force || dirBatch.length >= DIR_BATCH_ROWS) {
      count += dirBatch.length;
      await flushDirBatch(pool, workspaceId, dirBatch);
    }
  }

  async function maybeFlushFiles(force = false): Promise<void> {
    if (fileBatch.length === 0) return;
    if (force || fileBatch.length >= FILE_BATCH_ROWS || fileBatchBytes >= FILE_BATCH_BYTES) {
      count += fileBatch.length;
      await flushFileBatch(pool, workspaceId, fileBatch);
      fileBatchBytes = 0;
    }
  }

  async function walkDir(dirPath: string, dbParent: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return;
    }

    for (const name of entries) {
      const fullPath = join(dirPath, name);
      const dbPath = dbParent === '/' ? `/${name}` : `${dbParent}/${name}`;

      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (shouldExcludePath(dbPath, syncOpts, true)) continue;
        seenPaths.add(dbPath);
        const mtimeNs = BigInt(Math.floor(st.mtimeMs * 1_000_000));
        const prev = existing.get(dbPath);
        // Skip the upsert when the directory already exists with the same mtime
        // and (still) marked as a dir. Mode changes for dirs are rare and the
        // next real change will refresh the row.
        if (!prev || !prev.isDir || prev.mtimeNs !== mtimeNs) {
          dirBatch.push({ path: dbPath, parentPath: dbParent, name, mode: st.mode, mtimeNs: mtimeNs.toString() });
          await maybeFlushDirs();
        }
        await walkDir(fullPath, dbPath);
      } else if (st.isFile()) {
        if (shouldExcludePath(dbPath, syncOpts, false)) continue;
        seenPaths.add(dbPath);
        const mtimeNs = BigInt(Math.floor(st.mtimeMs * 1_000_000));
        const size = BigInt(st.size);
        const prev = existing.get(dbPath);
        // Skip when mtime AND size match — content is virtually guaranteed to
        // be identical. If a tool ever rewrites content without bumping mtime,
        // the size check catches it; if both somehow match exactly, the stale
        // copy in the DB lasts at most until the next real change.
        if (prev && !prev.isDir && prev.mtimeNs === mtimeNs && prev.size === size) {
          continue;
        }
        const content = readFileSync(fullPath);
        fileBatch.push({ path: dbPath, parentPath: dbParent, name, content, mode: st.mode, size: st.size, mtimeNs: mtimeNs.toString() });
        fileBatchBytes += content.length;
        await maybeFlushFiles();
      }
    }
  }

  // Ensure root exists (single small INSERT, unchanged shape so tests pass).
  const now = nowNs();
  await pool.query(
    `INSERT INTO _openeral.workspace_files
     (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
     VALUES ($1, '/', '', '', true, NULL, $2, 0, $3, $3, $3, 2, 1000, 1000)
     ON CONFLICT (workspace_id, path) DO NOTHING`,
    [workspaceId, 0o40755, now.toString()],
  );

  await walkDir(sourceDir, '/');
  await maybeFlushDirs(true);
  await maybeFlushFiles(true);

  if (syncOpts.prune) {
    // Use the snapshot we already loaded instead of a second SELECT pass.
    const toDelete: string[] = [];
    for (const path of existing.keys()) {
      if (path !== '/' && !seenPaths.has(path)) {
        toDelete.push(path);
      }
    }
    if (toDelete.length > 0) {
      // Single batched DELETE FROM _openeral.workspace_files — one round trip
      // for the whole prune set instead of one per stale row.
      await pool.query(
        `DELETE FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = ANY($2::text[])`,
        [workspaceId, toDelete],
      );
    }
  }

  return count;
}

/**
 * Watch a directory for changes and sync to PostgreSQL.
 * Returns a controller that exposes watcher dirty-state.
 */
export function watchAndSync(
  pool: pg.Pool,
  workspaceId: string,
  dir: string,
  opts?: SyncOptions & { debounceMs?: number },
): SyncWatchHandle {
  const debounceMs = opts?.debounceMs ?? 2000;
  const syncOpts = normalizeSyncOptions(opts);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let dirty = false;
  let suspended = 0;
  let watching = false;

  const ac = new AbortController();

  const markDirty = () => {
    dirty = true;
  };

  const markClean = () => {
    dirty = false;
  };

  const scheduleSync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!dirty || syncing || suspended > 0) return;
      syncing = true;
      void syncFromFs(pool, workspaceId, dir, syncOpts).then(() => {
        markClean();
      }).catch((err: unknown) => {
        process.stderr.write(`${formatSyncError(err, 'openeral: sync error')}\n`);
      }).finally(() => {
        syncing = false;
      });
    }, debounceMs);
  };

  try {
    const watcher = watch(dir, { recursive: true, signal: ac.signal });
    watching = true;

    watcher.on('change', (_event, filename) => {
      if (suspended > 0) return;
      if (typeof filename === 'string' && shouldExcludePath(filename, syncOpts)) return;
      markDirty();
      scheduleSync();
    });

    watcher.on('error', (err) => {
      watching = false;
      markDirty();
      process.stderr.write(`${formatSyncError(err, 'openeral: watcher error')}\n`);
    });
  } catch {
    // fs.watch may not support recursive on all platforms
  }

  return {
    stop() {
      ac.abort();
      if (timer) clearTimeout(timer);
    },
    isDirty() {
      return dirty;
    },
    isWatching() {
      return watching;
    },
    markDirty,
    markClean,
    async suspend<T>(fn: () => Promise<T>): Promise<T> {
      suspended++;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        return await fn();
      } finally {
        suspended = Math.max(0, suspended - 1);
      }
    },
  };
}
