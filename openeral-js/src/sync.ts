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
export const HOME_SYNC_EXCLUDE_PATH_PREFIXES = ['/.local/share/keyrings'];
export const HOME_SYNC_MAX_FILE_SIZE_BYTES = 1024 * 1024;

export interface SyncOptions {
  excludeDirs?: Set<string>;
  excludeFiles?: Set<string>;
  excludePathPrefixes?: string[];
  maxFileSizeBytes?: number;
  skipBinaryFiles?: boolean;
  prune?: boolean;
}

interface ResolvedSyncOptions {
  excludeDirs: Set<string>;
  excludeFiles: Set<string>;
  excludePathPrefixes: string[];
  maxFileSizeBytes?: number;
  skipBinaryFiles: boolean;
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
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? HOME_SYNC_MAX_FILE_SIZE_BYTES,
    skipBinaryFiles: overrides.skipBinaryFiles ?? true,
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
    maxFileSizeBytes: opts?.maxFileSizeBytes,
    skipBinaryFiles: opts?.skipBinaryFiles ?? false,
    prune: opts?.prune ?? true,
  };
}

function isBinaryContent(content: Buffer): boolean {
  if (content.length === 0) return false;

  const sample = content.subarray(0, Math.min(content.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if ((byte < 7 || (byte > 14 && byte < 32) || byte === 127)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
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

/**
 * Scan a real directory and upsert all files into workspace_files.
 * Deletes DB rows for files that no longer exist on disk.
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
        const now = nowNs();
        seenPaths.add(dbPath);
        await pool.query(
          `INSERT INTO _openeral.workspace_files
           (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
           VALUES ($1, $2, $3, $4, true, NULL, $5, 0, $6, $6, $6, 2, 1000, 1000)
           ON CONFLICT (workspace_id, path) DO UPDATE SET mode = $5, mtime_ns = $6`,
          [workspaceId, dbPath, dbParent, name, st.mode, now.toString()],
        );
        count++;
        await walkDir(fullPath, dbPath);
      } else if (st.isFile()) {
        if (shouldExcludePath(dbPath, syncOpts, false)) continue;
        if (syncOpts.maxFileSizeBytes !== undefined && st.size > syncOpts.maxFileSizeBytes) continue;
        const content = readFileSync(fullPath);
        if (syncOpts.skipBinaryFiles && isBinaryContent(content)) continue;
        const now = nowNs();
        seenPaths.add(dbPath);
        await pool.query(
          `INSERT INTO _openeral.workspace_files
           (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
           VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, $8, $8, 1, 1000, 1000)
           ON CONFLICT (workspace_id, path) DO UPDATE SET content = $5, mode = $6, size = $7, mtime_ns = $8`,
          [workspaceId, dbPath, dbParent, name, content, st.mode, st.size, now.toString()],
        );
        count++;
      }
    }
  }

  // Ensure root exists
  const now = nowNs();
  await pool.query(
    `INSERT INTO _openeral.workspace_files
     (workspace_id, path, parent_path, name, is_dir, content, mode, size, mtime_ns, ctime_ns, atime_ns, nlink, uid, gid)
     VALUES ($1, '/', '', '', true, NULL, $2, 0, $3, $3, $3, 2, 1000, 1000)
     ON CONFLICT (workspace_id, path) DO NOTHING`,
    [workspaceId, 0o40755, now.toString()],
  );

  await walkDir(sourceDir, '/');

  // Delete DB rows for files that no longer exist on disk
  const { rows: dbRows } = await pool.query(
    `SELECT path FROM _openeral.workspace_files WHERE workspace_id = $1 AND path != '/'`,
    [workspaceId],
  );
  for (const row of dbRows) {
    if (!seenPaths.has(row.path)) {
      await pool.query(
        `DELETE FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = $2`,
        [workspaceId, row.path],
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
