/**
 * Bidirectional sync between PostgreSQL workspace_files and the real filesystem.
 *
 * syncToFs:    PostgreSQL → real filesystem (startup)
 * syncFromFs:  real filesystem → PostgreSQL (shutdown / on-change)
 * watchAndSync: continuous background sync via fs.watch
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, unlinkSync, rmSync, existsSync, watch } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import type pg from 'pg';

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Default directories to skip — exact basename matches only. */
const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.openeral']);

function shouldExclude(name: string, excludeDirs: Set<string>): boolean {
  return excludeDirs.has(name);
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
  opts?: { excludeDirs?: Set<string> },
): Promise<number> {
  const excludeDirs = opts?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;

  const { rows } = await pool.query(
    `SELECT path, is_dir, content, mode FROM _openeral.workspace_files
     WHERE workspace_id = $1 ORDER BY path`,
    [workspaceId],
  );

  const dbPaths = new Set(rows.map((r: any) => r.path as string));
  const dbTypes = new Map(rows.map((r: any) => [r.path as string, r.is_dir as boolean]));
  let count = 0;

  // Step 1: Prune stale local entries AND resolve type conflicts BEFORE creating.
  // A path that changed type (file↔dir) between sessions would cause EEXIST/EISDIR
  // if we tried to create first.
  pruneLocal(targetDir, '/', dbPaths, dbTypes, excludeDirs);

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
  excludeDirs: Set<string>,
): void {
  const fullDir = join(baseDir, dbParent);
  let entries: string[];
  try {
    entries = readdirSync(fullDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (shouldExclude(name, excludeDirs)) continue;

    const fullPath = join(fullDir, name);
    const dbPath = dbParent === '/' ? `/${name}` : `${dbParent}/${name}`;

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
      pruneLocal(baseDir, dbPath, dbPaths, dbTypes, excludeDirs);

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
  opts?: { excludeDirs?: Set<string> },
): Promise<number> {
  const excludeDirs = opts?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
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
      if (shouldExclude(name, excludeDirs)) continue;

      const fullPath = join(dirPath, name);
      const dbPath = dbParent === '/' ? `/${name}` : `${dbParent}/${name}`;

      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      const now = nowNs();
      seenPaths.add(dbPath);

      if (st.isDirectory()) {
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
        const content = readFileSync(fullPath);
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
 * Returns a stop function.
 */
export function watchAndSync(
  pool: pg.Pool,
  workspaceId: string,
  dir: string,
  opts?: { debounceMs?: number; excludeDirs?: Set<string> },
): () => void {
  const debounceMs = opts?.debounceMs ?? 2000;
  const excludeDirs = opts?.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;

  const ac = new AbortController();

  try {
    const watcher = watch(dir, { recursive: true, signal: ac.signal });

    watcher.on('change', (_event, filename) => {
      if (typeof filename === 'string') {
        // Check each path segment against excludeDirs
        const segments = filename.split('/');
        if (segments.some(s => shouldExclude(s, excludeDirs))) return;
      }

      // Debounce: wait for changes to settle before syncing
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (syncing) return;
        syncing = true;
        try {
          await syncFromFs(pool, workspaceId, dir, { excludeDirs });
        } catch (err: any) {
          process.stderr.write(`openeral: sync error: ${err.message}\n`);
        } finally {
          syncing = false;
        }
      }, debounceMs);
    });

    watcher.on('error', () => {}); // ignore watcher errors
  } catch {
    // fs.watch may not support recursive on all platforms
  }

  return () => {
    ac.abort();
    if (timer) clearTimeout(timer);
  };
}
