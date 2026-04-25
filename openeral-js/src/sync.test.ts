import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const syncSrc = readFileSync(join(__dirname, 'sync.ts'), 'utf8');

describe('sync.ts structural checks', () => {
  it('syncFromFs tracks seen paths for deletion', () => {
    expect(syncSrc).toContain('seenPaths');
    expect(syncSrc).toContain('seenPaths.add(');
  });

  it('syncFromFs can delete DB rows not seen on disk', () => {
    expect(syncSrc).toMatch(/DELETE FROM _openeral\.workspace_files/);
    expect(syncSrc).toContain('if (syncOpts.prune)');
    expect(syncSrc).toContain('!seenPaths.has(');
  });

  it('syncFromFs uses st.mode, not hardcoded values', () => {
    // Only check the walkDir function body (exclude the root dir INSERT)
    const walkDirStart = syncSrc.indexOf('async function walkDir');
    const walkDirEnd = syncSrc.indexOf('// Ensure root exists');
    const walkDirBody = syncSrc.slice(walkDirStart, walkDirEnd);
    expect(walkDirBody).toContain('st.mode');
    const insertStatements = walkDirBody.match(/INSERT INTO[\s\S]*?ON CONFLICT[\s\S]*?\]/g) || [];
    for (const stmt of insertStatements) {
      expect(stmt).not.toMatch(/0o40755|0o100644/);
    }
  });

  it('syncToFs applies chmod after writing files', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    expect(syncToFsBody).toContain('chmodSync(');
    expect(syncToFsBody).toContain('row.mode & 0o7777');
  });

  it('syncToFs prunes local files not in DB', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    expect(syncToFsBody).toContain('pruneLocal');
  });

  it('exclude uses exact directory name matching, not regex substring', () => {
    // Must use Set-based matching, not regex
    expect(syncSrc).toContain('DEFAULT_EXCLUDE_DIRS');
    expect(syncSrc).toContain("new Set(['node_modules', '.git', '.openeral'])");
    // shouldExclude must use .has(), not .test()
    expect(syncSrc).toContain('excludeDirs.has(name)');
    // Must NOT have a regex-based exclude that would match .gitignore
    expect(syncSrc).not.toMatch(/exclude\.test\(name\)/);
  });

  it('.gitignore and .github are NOT excluded', () => {
    expect(syncSrc).not.toContain('/node_modules|\\.git/');
  });

  it('syncToFs prunes BEFORE creating (handles type conflicts)', () => {
    const syncToFsBody = syncSrc.slice(
      syncSrc.indexOf('export async function syncToFs'),
      syncSrc.indexOf('export async function syncFromFs'),
    );
    const pruneIdx = syncToFsBody.indexOf('pruneLocal');
    const mkdirIdx = syncToFsBody.indexOf('mkdirSync(fullPath');
    const writeIdx = syncToFsBody.indexOf('writeFileSync(fullPath');
    // pruneLocal must appear BEFORE mkdir and writeFile
    expect(pruneIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeGreaterThan(pruneIdx);
    expect(writeIdx).toBeGreaterThan(pruneIdx);
  });

  it('pruneLocal handles type conflicts (file↔dir)', () => {
    // pruneLocal must check dbTypes for type mismatches, not just presence
    expect(syncSrc).toContain('dbTypes');
    expect(syncSrc).toContain('dbIsDir === false');
    expect(syncSrc).toContain('dbIsDir === true');
  });

  it('home sync policy excludes sensitive dirs, files, and keyrings', () => {
    expect(syncSrc).toContain('HOME_SYNC_EXCLUDE_DIRS');
    expect(syncSrc).toContain("'.ssh'");
    expect(syncSrc).toContain("'.aws'");
    expect(syncSrc).toContain("'.azure'");
    expect(syncSrc).toContain("'.gnupg'");
    expect(syncSrc).toContain("'.config'");
    expect(syncSrc).toContain('HOME_SYNC_EXCLUDE_FILES');
    expect(syncSrc).toContain("'.npmrc'");
    expect(syncSrc).toContain("'.git-credentials'");
    expect(syncSrc).toContain("'.netrc'");
    expect(syncSrc).toContain("['/.local/share/keyrings']");
  });

  it('home sync policy disables pruning without filtering by file size or type', () => {
    expect(syncSrc).toContain('createHomeSyncOptions');
    expect(syncSrc).toContain('prune: overrides.prune ?? false');
    expect(syncSrc).not.toContain('maxFileSizeBytes');
    expect(syncSrc).not.toContain('skipBinaryFiles');
  });

  it('syncFromFs reads file content without size or binary cutoffs', () => {
    expect(syncSrc).toContain('const content = readFileSync(fullPath);');
    expect(syncSrc).not.toContain('isBinaryContent');
    expect(syncSrc).not.toContain('syncOpts.maxFileSizeBytes');
    expect(syncSrc).not.toContain('syncOpts.skipBinaryFiles');
  });

  it('watchAndSync exposes dirty-state controls for sync fast paths', () => {
    expect(syncSrc).toContain('export interface SyncWatchHandle');
    expect(syncSrc).toContain('isDirty(): boolean');
    expect(syncSrc).toContain('isWatching(): boolean');
    expect(syncSrc).toContain('markClean(): void');
    expect(syncSrc).toContain('async suspend<T>(');
  });
});
