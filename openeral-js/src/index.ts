/**
 * openeral-js — PostgreSQL-backed virtual filesystem for AI agents via just-bash.
 *
 * Replaces Linux FUSE with a TypeScript bash interpreter. The agent's bash tool
 * routes through just-bash with two virtual mounts:
 *   /db          — read-only view of the PostgreSQL database
 *   /home/agent  — read-write persistent workspace stored in PostgreSQL
 *
 * No kernel modules, no /dev/fuse, no privileged containers.
 */

// Shell factory (main entry point)
export {
  createOpeneralShell,
  createToolHandler,
  EXECUTION_LIMITS,
} from './shell.js';
export type {
  OpeneralShellOptions,
  ExecResult,
} from './shell.js';

// Filesystem implementations (for custom compositions)
export { PgFs } from './pg-fs/pg-fs.js';
export { WorkspaceFs } from './workspace-fs/workspace-fs.js';

// Path parser (for custom analysis)
export { parsePath, isDirectory, parsePkDisplay } from './pg-fs/path-parser.js';
export type { PgNode } from './pg-fs/path-parser.js';

// Filesystem sync (PostgreSQL ↔ real filesystem)
export { syncToFs, syncFromFs, watchAndSync } from './sync.js';

// Database utilities
export { createPool } from './db/pool.js';
export { runMigrations } from './db/migrations.js';

// Command safety analysis
export { analyzeCommand, analyzeCommandSync } from './safety.js';
export type { AnalysisResult, BashInvocation } from './safety.js';

// Optimizer
export { createOptimizer, Optimizer } from './optimize/index.js';
export type { 
  APIRequest, 
  APIResponse, 
  OptimizerConfig, 
  OptimizationMetrics 
} from './optimize/index.js';
export { DEFAULT_OPTIMIZER_CONFIG } from './optimize/index.js';

// Types
export type {
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  PrimaryKeyInfo,
  IndexInfo,
  RowIdentifier,
  WorkspaceFile,
} from './db/types.js';
