import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectMemoryChunks } from './collect.js';
import { rankMemoryChunks, readDirtyPathSet, selectTopChunks } from './rank.js';
import { renderMemoryIndex, renderTopicFile, slugifyQuery } from './render.js';
import { resolveProjectContext } from './resolve.js';
import type { MemoryChunk, MemoryFileSpec, MemoryRefreshOptions, MemoryRefreshResult, MemorySourceKind, RankedMemoryChunk } from './types.js';

interface MemoryDocumentTemplate {
  filename: string;
  name: string;
  description: string;
  type: string;
  preferKinds?: MemorySourceKind[];
}

const DEFAULT_TEMPLATES: Array<MemoryDocumentTemplate & { query: string; limit?: number }> = [
  {
    filename: 'project-overview.md',
    name: 'Project overview',
    description: 'Goals, architecture, and important project context',
    type: 'project',
    query: 'project overview architecture goals design README CLAUDE MEMORY project',
    preferKinds: ['memory', 'instruction', 'doc', 'config'],
  },
  {
    filename: 'build-and-test.md',
    name: 'Build and test',
    description: 'Repeated install, build, run, and verification commands',
    type: 'workflow',
    query: 'build test install run pnpm npm npx node docker openshell verify check integration e2e',
    preferKinds: ['memory', 'instruction', 'doc', 'config'],
  },
  {
    filename: 'debugging.md',
    name: 'Debugging',
    description: 'Known failure modes, diagnostics, and troubleshooting clues',
    type: 'debugging',
    query: 'debug troubleshooting error failure bug issue warning diagnose gotcha fix',
    preferKinds: ['memory', 'instruction', 'doc', 'config'],
  },
  {
    filename: 'style-and-rules.md',
    name: 'Style and rules',
    description: 'Non-negotiable coding rules, safety constraints, and conventions',
    type: 'rules',
    query: 'style rules convention prefer always never must do not safety constraint feedback',
    preferKinds: ['memory', 'instruction', 'doc', 'config'],
  },
  {
    filename: 'workflow.md',
    name: 'Workflow',
    description: 'Operational flow, launch steps, and recurring task sequences',
    type: 'workflow',
    query: 'workflow process steps launch session persistence shell openshell setup command sequence',
    preferKinds: ['memory', 'instruction', 'doc', 'config'],
  },
];

function hasMarkdownFiles(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    return readdirSync(dirPath).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

function createBackup(memoryDir: string, backupBaseDir: string, now: Date): string | undefined {
  if (!hasMarkdownFiles(memoryDir)) return undefined;

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupDir = join(backupBaseDir, stamp);
  mkdirSync(backupBaseDir, { recursive: true });
  cpSync(memoryDir, backupDir, { recursive: true });
  return backupDir;
}

function removeExistingMarkdown(memoryDir: string): void {
  if (!existsSync(memoryDir)) return;
  for (const name of readdirSync(memoryDir)) {
    if (!name.endsWith('.md')) continue;
    rmSync(join(memoryDir, name), { force: true });
  }
}

function uniqueTopSources(chunks: RankedMemoryChunk[], limit = 12): RankedMemoryChunk[] {
  const unique = new Map<string, RankedMemoryChunk>();
  for (const chunk of chunks) {
    const existing = unique.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) {
      unique.set(chunk.chunkId, chunk);
    }
  }
  return [...unique.values()]
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath))
    .slice(0, limit);
}

function selectPreferredChunks(
  ranked: RankedMemoryChunk[],
  opts?: { limit?: number; maxPerFile?: number; preferKinds?: MemorySourceKind[] },
): RankedMemoryChunk[] {
  const preferKinds = opts?.preferKinds;
  if (!preferKinds || preferKinds.length === 0) {
    return selectTopChunks(ranked, opts);
  }

  const preferred = rankSelectedKinds(ranked, preferKinds, true);
  const fallback = rankSelectedKinds(ranked, preferKinds, false);
  return selectTopChunks([...preferred, ...fallback], opts);
}

function rankSelectedKinds(
  ranked: RankedMemoryChunk[],
  kinds: MemorySourceKind[],
  included: boolean,
): RankedMemoryChunk[] {
  return ranked.filter((chunk) => kinds.includes(chunk.kind) === included);
}

function buildDefaultMemoryFiles(
  chunks: MemoryChunk[],
  now: Date,
  dirtyPaths: Set<string>,
): { docs: MemoryFileSpec[]; topSources: RankedMemoryChunk[] } {
  const docs: MemoryFileSpec[] = [];
  const selected: RankedMemoryChunk[] = [];

  for (const template of DEFAULT_TEMPLATES) {
    const ranked = rankMemoryChunks(chunks, template.query, { now, dirtyPaths });
    const top = selectPreferredChunks(ranked, {
      limit: template.limit ?? 8,
      maxPerFile: 2,
      preferKinds: template.preferKinds,
    });
    const doc = renderTopicFile(template, top);
    if (doc) {
      docs.push(doc);
      selected.push(...top);
    }
  }

  return { docs, topSources: uniqueTopSources(selected) };
}

function buildFocusMemoryFile(
  chunks: MemoryChunk[],
  query: string,
  now: Date,
  dirtyPaths: Set<string>,
): { docs: MemoryFileSpec[]; topSources: RankedMemoryChunk[] } {
  const ranked = rankMemoryChunks(chunks, query, { now, dirtyPaths });
  const top = selectTopChunks(ranked, { limit: 10, maxPerFile: 2 });

  const template: MemoryDocumentTemplate = {
    filename: `focus-${slugifyQuery(query)}.md`,
    name: `Focus: ${query}`,
    description: `Relevant context and fresh details for query: ${query}`,
    type: 'focus',
  };

  const doc = renderTopicFile(template, top, { query });
  return {
    docs: doc ? [doc] : [],
    topSources: uniqueTopSources(top),
  };
}

function writeMemoryFiles(memoryDir: string, docs: MemoryFileSpec[], query?: string): void {
  mkdirSync(memoryDir, { recursive: true });
  removeExistingMarkdown(memoryDir);

  const index = renderMemoryIndex(
    docs.map((doc) => ({ name: doc.name, description: doc.description })),
    query ? { query } : undefined,
  );
  writeFileSync(join(memoryDir, 'MEMORY.md'), index);

  for (const doc of docs) {
    writeFileSync(join(memoryDir, doc.name), doc.content);
  }
}

export async function refreshClaudeMemory(opts: MemoryRefreshOptions): Promise<MemoryRefreshResult> {
  const now = opts.now ?? new Date();
  const context = resolveProjectContext({
    homeDir: opts.homeDir,
    cwd: opts.cwd,
    projectRoot: opts.projectRoot,
  });

  const allChunks = collectMemoryChunks(context);
  const dirtyPaths = readDirtyPathSet(context.contentRoot);
  const trimmedQuery = opts.query?.trim();
  const mode = !trimmedQuery || trimmedQuery.toLowerCase() === 'default' ? 'default' : 'focus';

  const { docs, topSources } = mode === 'default'
    ? buildDefaultMemoryFiles(allChunks, now, dirtyPaths)
    : buildFocusMemoryFile(allChunks, trimmedQuery!, now, dirtyPaths);

  const plannedFiles = ['MEMORY.md', ...docs.map((doc) => doc.name)];

  let backupDir: string | undefined;
  if (!opts.dryRun) {
    if (opts.backup !== false) {
      backupDir = createBackup(context.memoryDir, context.backupBaseDir, now);
    }
    writeMemoryFiles(context.memoryDir, docs, mode === 'focus' ? trimmedQuery : undefined);
  }

  return {
    mode,
    context,
    plannedFiles,
    writtenFiles: opts.dryRun ? [] : plannedFiles,
    backupDir,
    topSources,
    dryRun: !!opts.dryRun,
  };
}
