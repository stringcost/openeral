export type MemorySourceKind = 'memory' | 'instruction' | 'doc' | 'config' | 'code';

export interface ProjectContext {
  homeDir: string;
  contentRoot: string;
  memoryKeyRoot: string;
  projectSlug: string;
  memoryDir: string;
  backupBaseDir: string;
}

export interface MemorySourceFile {
  absPath: string;
  relPath: string;
  kind: MemorySourceKind;
  content: string;
  mtimeMs: number;
}

export interface MemoryChunk extends MemorySourceFile {
  chunkId: string;
  title: string;
  excerpt: string;
  tokenSet: Set<string>;
}

export interface RankedMemoryChunk extends MemoryChunk {
  score: number;
  reasons: string[];
}

export interface MemoryFileSpec {
  name: string;
  description: string;
  type: string;
  content: string;
}

export interface MemoryRefreshOptions {
  homeDir: string;
  cwd?: string;
  projectRoot?: string;
  query?: string;
  dryRun?: boolean;
  backup?: boolean;
  now?: Date;
}

export interface MemoryRefreshResult {
  mode: 'default' | 'focus';
  context: ProjectContext;
  plannedFiles: string[];
  writtenFiles: string[];
  backupDir?: string;
  topSources: RankedMemoryChunk[];
  dryRun: boolean;
}
