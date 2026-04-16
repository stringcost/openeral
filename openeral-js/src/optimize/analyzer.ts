/**
 * Strategic optimizer — analyzes session history and project structure to
 * propose concrete changes that reduce token usage in every future session.
 *
 * The analysis combines two data sources:
 *   1. DB (proxy logs): actual model usage, tokens per call, task types
 *   2. Filesystem: CLAUDE.md, memory files, project structure
 *
 * Output: ranked proposals each with a concrete apply action.
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { hostname } from 'node:os';
import type { DbPool } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelBreakdown {
  model: string;
  displayName: string;
  calls: number;
  tokens: number;
  pct: number;
}

export interface TaskBreakdown {
  taskType: string;
  calls: number;
  tokens: number;
  wastedOnExpensiveModel: number; // calls that used sonnet/opus but could use haiku
}

export interface SessionStats {
  hasData: boolean;
  sessionsAnalyzed: number;
  period: string;
  totalTokens: number;
  totalApiCalls: number;
  totalCost: number;
  avgTokensPerSession: number;
  avgTokensPerCall: number;
  avgCallsPerSession: number;
  avgCostPerSession: number;
  cacheHitRate: number;
  models: ModelBreakdown[];
  tasks: TaskBreakdown[];
}

export interface Proposal {
  id: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'model-routing' | 'context-efficiency' | 'memory' | 'workflow' | 'caching';
  title: string;
  /** What's happening right now (specific numbers from the data). */
  currentState: string;
  /** What will change after applying this proposal. */
  proposedChange: string;
  estimatedSavingsPct: number;
  estimatedSavingsTokensPerSession: number;
  howToApply: string;
  canAutoApply: boolean;
}

export interface PromptSurface {
  totalTokens: number;
  instructionFiles: Array<{ relPath: string; tokens: number }>;
  memoryFiles: Array<{ relPath: string; tokens: number }>;
  hasModelRouting: boolean;
  hasContextFile: boolean;
  hasContextFileInstruction: boolean;
  hasReadmeUpdateInstruction: boolean;
  hasLazyLoadInstruction: boolean;
}

export interface StrategicReport {
  generatedAt: string;
  projectRoot: string;
  memoryDir: string | null;
  sessionStats: SessionStats;
  promptSurface: PromptSurface;
  proposals: Proposal[];
  /**
   * null  = file-path tracking is not available (StringCost only stores token counts, not file paths)
   * []    = tracking available, no large files found
   * [...] = tracking available, large files found
   */
  hotspots: Array<{ relPath: string; tokens: number }> | null;
}

export interface AnalyzeOptions {
  pool?: DbPool | null;
  workspaceId?: string;
  projectRoot?: string;
  daysBack?: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// Project root / memory dir detection
// ---------------------------------------------------------------------------

function detectProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  let claudeCandidate: string | null = null;

  while (true) {
    if (existsSync(join(dir, 'CLAUDE.md'))) claudeCandidate = dir;
    if (existsSync(join(dir, '.git'))) {
      return existsSync(join(dir, 'CLAUDE.md')) ? dir : claudeCandidate ?? dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return claudeCandidate ?? startDir;
}

function detectMemoryDir(projectRoot: string, workspaceId: string): string | null {
  const encodedProject = projectRoot.replace(/\//g, '-');
  const candidates = [
    join(process.env.OPENERAL_HOME ?? `/tmp/openeral-${workspaceId}`, '.claude', 'projects', encodedProject, 'memory'),
    ...(process.env.HOME ? [join(process.env.HOME, '.claude', 'projects', encodedProject, 'memory')] : []),
  ];
  return candidates.find(c => existsSync(c)) ?? null;
}

// ---------------------------------------------------------------------------
// DB analysis — session history
// ---------------------------------------------------------------------------

async function querySessionStats(
  pool: DbPool,
  workspaceId: string,
  daysBack: number,
): Promise<SessionStats> {
  // Check if the table exists at all
  try {
    await pool.query(`SELECT 1 FROM _openeral.optimization_metrics LIMIT 1`);
  } catch {
    return emptySessionStats(daysBack);
  }

  // Overall totals
  const totals = await pool.query<{
    total_tokens: string;
    total_calls: string;
    total_cost: string;
    cache_hits: string;
  }>(
    `SELECT
       COALESCE(SUM(optimized_prompt_tokens), 0)::text   AS total_tokens,
       COUNT(*)::text                                      AS total_calls,
       COALESCE(SUM(optimized_actual_cost), 0)::text      AS total_cost,
       COALESCE(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)::text AS cache_hits
     FROM _openeral.optimization_metrics
     WHERE workspace_id = $1
       AND timestamp > NOW() - INTERVAL '1 day' * $2`,
    [workspaceId, daysBack],
  );

  const row = totals.rows[0];
  const totalTokens = parseInt(row?.total_tokens ?? '0', 10);
  const totalCalls = parseInt(row?.total_calls ?? '0', 10);
  const totalCost = parseFloat(row?.total_cost ?? '0');
  const cacheHits = parseInt(row?.cache_hits ?? '0', 10);

  if (totalCalls === 0) return emptySessionStats(daysBack);

  // Session grouping (sessions identified by metadata->>'session_id')
  const sessionsResult = await pool.query<{ session_id: string; tokens: string; calls: string; cost: string }>(
    `SELECT
       COALESCE(metadata->>'session_id', 'unknown') AS session_id,
       SUM(optimized_prompt_tokens)::text            AS tokens,
       COUNT(*)::text                                AS calls,
       SUM(optimized_actual_cost)::text              AS cost
     FROM _openeral.optimization_metrics
     WHERE workspace_id = $1
       AND timestamp > NOW() - INTERVAL '1 day' * $2
     GROUP BY metadata->>'session_id'`,
    [workspaceId, daysBack],
  );

  const sessionsAnalyzed = sessionsResult.rows.length;
  const avgTokensPerSession = sessionsAnalyzed > 0 ? Math.round(totalTokens / sessionsAnalyzed) : totalTokens;
  const avgCallsPerSession = sessionsAnalyzed > 0 ? parseFloat((totalCalls / sessionsAnalyzed).toFixed(1)) : totalCalls;

  // Model breakdown
  const modelResult = await pool.query<{ model: string; calls: string; tokens: string }>(
    `SELECT optimized_model AS model, COUNT(*)::text AS calls, SUM(optimized_prompt_tokens)::text AS tokens
     FROM _openeral.optimization_metrics
     WHERE workspace_id = $1
       AND timestamp > NOW() - INTERVAL '1 day' * $2
     GROUP BY optimized_model`,
    [workspaceId, daysBack],
  );

  const models: ModelBreakdown[] = modelResult.rows.map(r => ({
    model: r.model,
    displayName: r.model.includes('haiku') ? 'Haiku' : r.model.includes('sonnet') ? 'Sonnet' : r.model.includes('opus') ? 'Opus' : r.model,
    calls: parseInt(r.calls, 10),
    tokens: parseInt(r.tokens, 10),
    pct: Math.round((parseInt(r.tokens, 10) / totalTokens) * 100),
  })).sort((a, b) => b.tokens - a.tokens);

  // Task breakdown
  const taskResult = await pool.query<{ task_type: string; calls: string; tokens: string; wasted: string }>(
    `SELECT
       task_type,
       COUNT(*)::text AS calls,
       SUM(optimized_prompt_tokens)::text AS tokens,
       SUM(CASE WHEN (optimized_model LIKE '%sonnet%' OR optimized_model LIKE '%opus%')
                 AND task_type IN ('file_read', 'file_list', 'bash', 'search')
                THEN 1 ELSE 0 END)::text AS wasted
     FROM _openeral.optimization_metrics
     WHERE workspace_id = $1
       AND timestamp > NOW() - INTERVAL '1 day' * $2
     GROUP BY task_type`,
    [workspaceId, daysBack],
  );

  const tasks: TaskBreakdown[] = taskResult.rows.map(r => ({
    taskType: r.task_type || 'unknown',
    calls: parseInt(r.calls, 10),
    tokens: parseInt(r.tokens, 10),
    wastedOnExpensiveModel: parseInt(r.wasted, 10),
  })).sort((a, b) => b.tokens - a.tokens);

  return {
    hasData: true,
    sessionsAnalyzed,
    period: `Last ${daysBack} days`,
    totalTokens,
    totalApiCalls: totalCalls,
    totalCost,
    avgTokensPerSession,
    avgTokensPerCall: Math.round(totalTokens / totalCalls),
    avgCallsPerSession,
    avgCostPerSession: totalCost / (sessionsAnalyzed || 1),
    cacheHitRate: totalCalls > 0 ? Math.round((cacheHits / totalCalls) * 100) : 0,
    models,
    tasks,
  };
}

function emptySessionStats(daysBack: number): SessionStats {
  return {
    hasData: false,
    sessionsAnalyzed: 0,
    period: `Last ${daysBack} days`,
    totalTokens: 0,
    totalApiCalls: 0,
    totalCost: 0,
    avgTokensPerSession: 0,
    avgTokensPerCall: 0,
    avgCallsPerSession: 0,
    avgCostPerSession: 0,
    cacheHitRate: 0,
    models: [],
    tasks: [],
  };
}

// ---------------------------------------------------------------------------
// File / prompt surface analysis
// ---------------------------------------------------------------------------

function readFile(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readMarkdownFiles(dir: string): Array<{ name: string; content: string }> {
  try {
    return readdirSync(dir)
      .filter((n): n is string => typeof n === 'string' && n.endsWith('.md'))
      .sort()
      .map(name => {
        const content = readFile(join(dir, name));
        return { name, content };
      })
      .filter(f => f.content.length > 0);
  } catch {
    return [];
  }
}

function analyzePromptSurfaceFiles(
  projectRoot: string,
  memoryDir: string | null,
): PromptSurface {
  // Instruction files: CLAUDE.md in project root and parent
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  const parentClaudeMd = join(projectRoot, '..', 'CLAUDE.md');
  const instructionFiles: Array<{ relPath: string; tokens: number }> = [];

  const claudeContent = readFile(claudeMdPath);
  if (claudeContent) {
    instructionFiles.push({ relPath: 'CLAUDE.md', tokens: estimateTokens(claudeContent) });
  }
  const parentContent = readFile(resolve(parentClaudeMd));
  if (parentContent && resolve(parentClaudeMd) !== claudeMdPath) {
    instructionFiles.push({ relPath: relative(projectRoot, resolve(parentClaudeMd)), tokens: estimateTokens(parentContent) });
  }

  // Memory files
  const memFiles = memoryDir ? readMarkdownFiles(memoryDir) : [];
  const memoryFiles = memFiles.map(f => ({
    relPath: `memory/${f.name}`,
    tokens: estimateTokens(f.content),
  }));

  const totalTokens =
    instructionFiles.reduce((s, f) => s + f.tokens, 0) +
    memoryFiles.reduce((s, f) => s + f.tokens, 0);

  // Detect what's already in CLAUDE.md
  const allInstructions = [claudeContent, parentContent].join('\n').toLowerCase();

  const hasModelRouting =
    allInstructions.includes('model selection') ||
    allInstructions.includes('model routing') ||
    allInstructions.includes('haiku') ||
    allInstructions.includes('use claude');

  const contextFilePath = join(projectRoot, '.claude', 'CONTEXT.md');
  const hasContextFile = existsSync(contextFilePath) || existsSync(join(projectRoot, 'CONTEXT.md'));

  const hasContextFileInstruction =
    allInstructions.includes('context.md') ||
    allInstructions.includes('context file');

  const hasReadmeUpdateInstruction =
    allInstructions.includes('update readme') ||
    allInstructions.includes('readme after') ||
    allInstructions.includes('update the readme');

  const hasLazyLoadInstruction =
    allInstructions.includes('only read files') ||
    allInstructions.includes('grep') && allInstructions.includes('before reading');

  return {
    totalTokens,
    instructionFiles,
    memoryFiles,
    hasModelRouting,
    hasContextFile,
    hasContextFileInstruction,
    hasReadmeUpdateInstruction,
    hasLazyLoadInstruction,
  };
}

// ---------------------------------------------------------------------------
// Hotspot detection - files actually read during sessions
// ---------------------------------------------------------------------------

async function findActualHotspots(
  pool: DbPool | null | undefined,
  workspaceId: string,
  daysBack: number,
  projectRoot: string,
  topN = 5
): Promise<Array<{ relPath: string; tokens: number }> | null> {
  if (!pool) return null;

  try {
    // First: check whether any rows in the window have file_path in metadata at all.
    // StringCost events never populate file_path — only the old proxy-based optimizer did.
    // If no rows have it, we don't have the data; return null to signal "unavailable"
    // rather than [] which would mean "available, nothing large found".
    const hasFilePathData = await pool.query<{ has_data: string }>(
      `SELECT EXISTS (
         SELECT 1 FROM _openeral.optimization_metrics
         WHERE workspace_id = $1
           AND timestamp > NOW() - INTERVAL '1 day' * $2
           AND metadata->>'file_path' IS NOT NULL
       ) AS has_data`,
      [workspaceId, daysBack],
    );

    if (hasFilePathData.rows[0]?.has_data !== 'true') {
      // No file-path tracking data — StringCost only logs token counts per API call,
      // not which files were read inside each call.
      return null;
    }

    // File-path data exists — query it
    const result = await pool.query<{ file_path: string; read_count: string }>(
      `SELECT
         metadata->>'file_path' AS file_path,
         COUNT(*)::text AS read_count
       FROM _openeral.optimization_metrics
       WHERE workspace_id = $1
         AND timestamp > NOW() - INTERVAL '1 day' * $2
         AND metadata->>'file_path' IS NOT NULL
       GROUP BY metadata->>'file_path'
       ORDER BY COUNT(*) DESC
       LIMIT $3`,
      [workspaceId, daysBack, topN * 2],
    );

    const hotspots: Array<{ relPath: string; tokens: number }> = [];

    for (const row of result.rows) {
      const filePath = row.file_path;
      if (!filePath) continue;

      const fullPath = join(projectRoot, filePath);
      try {
        const content = readFileSync(fullPath, 'utf8');
        const tokens = estimateTokens(content);
        if (tokens >= 1000) {
          hotspots.push({ relPath: filePath, tokens });
        }
      } catch {
        continue;
      }
    }

    return hotspots.sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

function buildProposals(
  stats: SessionStats,
  surface: PromptSurface,
  projectRoot: string,
): Proposal[] {
  const proposals: Proposal[] = [];

  const avgTokens = stats.hasData ? stats.avgTokensPerSession : surface.totalTokens;
  const hasReadme = existsSync(join(projectRoot, 'README.md'));

  // ── 1. Model routing ──────────────────────────────────────────────────────
  if (!surface.hasModelRouting && stats.hasData) {
    // Only recommend if there's actual waste - expensive models used for simple tasks
    const wastedCalls = stats.tasks.reduce((s, t) => s + t.wastedOnExpensiveModel, 0);
    const expensiveModels = stats.models.filter(m => m.displayName !== 'Haiku');
    const expensivePct = expensiveModels.reduce((s, m) => s + m.pct, 0);
    
    // Only recommend if >20% of tokens went to expensive models OR there were wasted calls
    if (expensivePct > 20 || wastedCalls > 0) {
      const current = `${expensivePct}% of tokens spent on Sonnet/Opus (${wastedCalls} simple-task calls used expensive models)`;
      const savings = Math.round(avgTokens * 0.35);

      proposals.push({
        id: 'model-routing',
        priority: 'HIGH',
        category: 'model-routing',
        title: 'Add model routing rules to CLAUDE.md',
        currentState: current,
        proposedChange:
          'Claude selects Haiku for file reads / searches / simple edits, Sonnet for coding tasks, ' +
          'Opus only for complex multi-step reasoning. Routing is enforced via instructions in CLAUDE.md.',
        estimatedSavingsPct: 35,
        estimatedSavingsTokensPerSession: savings,
        howToApply: 'Run: npx openeral optimize apply --proposal model-routing',
        canAutoApply: true,
      });
    }
  }

  // ── 2. Compact context file ────────────────────────────────────────────────
  if (!surface.hasContextFile && !surface.hasContextFileInstruction && stats.hasData) {
    // Only recommend if sessions are actually expensive (>2000 tokens avg)
    // Simple Q&A sessions don't need CONTEXT.md
    if (stats.avgTokensPerSession > 2000) {
      const current = `Each session averages ${stats.avgTokensPerSession.toLocaleString()} tokens. ` +
        `Claude re-explores project files every session instead of reading a compact state file.`;
      const savings = Math.round(avgTokens * 0.28);

      proposals.push({
        id: 'context-file',
        priority: 'HIGH',
        category: 'context-efficiency',
        title: 'Create a living CONTEXT.md Claude reads and updates each session',
        currentState: current,
        proposedChange:
          'Create .claude/CONTEXT.md as a compact project state file. ' +
          'Claude reads it first (instead of re-exploring), then updates it after each task. ' +
          'Next session starts with fresh context in ~200 tokens instead of reading 5-10 files.',
        estimatedSavingsPct: 28,
        estimatedSavingsTokensPerSession: savings,
        howToApply: 'Run: npx openeral optimize apply --proposal context-file',
        canAutoApply: true,
      });
    }
  }

  // ── 3. README auto-update instruction ─────────────────────────────────────
  if (hasReadme && !surface.hasReadmeUpdateInstruction && stats.hasData) {
    // Only recommend if sessions are doing actual coding work (>3000 tokens avg)
    if (avgTokens > 3000) {
      const savings = Math.round(avgTokens * 0.15);

      proposals.push({
        id: 'readme-updates',
        priority: 'HIGH',
        category: 'workflow',
        title: 'Instruct Claude to keep README current after each task',
        currentState:
          'Claude re-reads source files for context in each session. ' +
          'README is not used as a live state document.',
        proposedChange:
          'Add a workflow rule to CLAUDE.md: after completing a coding task, Claude updates the ' +
          'relevant section of README.md. Future sessions read README for context instead of ' +
          'exploring source files from scratch — saves 1-3 file reads per session.',
        estimatedSavingsPct: 15,
        estimatedSavingsTokensPerSession: savings,
        howToApply: 'Run: npx openeral optimize apply --proposal readme-updates',
        canAutoApply: true,
      });
    }
  }

  // ── 4. Lazy file reading rule ─────────────────────────────────────────────
  if (!surface.hasLazyLoadInstruction && stats.hasData && stats.avgTokensPerCall > 2500) {
    const savings = Math.round(avgTokens * 0.20);

    proposals.push({
      id: 'lazy-reading',
      priority: 'HIGH',
      category: 'context-efficiency',
      title: 'Add lazy-loading rule — grep before reading full files',
      currentState:
        `Avg ${stats.avgTokensPerCall.toLocaleString()} tokens per API call. ` +
        'Large files are likely being read in full when only a few lines are needed.',
      proposedChange:
        'Add rule to CLAUDE.md: "Before reading any file in full, use Grep to find the relevant ' +
        'section. Read only what is needed. Prefer targeted reads over full file reads." ' +
        'This prevents expensive full reads of large source files.',
      estimatedSavingsPct: 20,
      estimatedSavingsTokensPerSession: savings,
      howToApply: 'Run: npx openeral optimize apply --proposal lazy-reading',
      canAutoApply: true,
    });
  }

  // ── 5. Memory compaction ──────────────────────────────────────────────────
  const memTokens = surface.memoryFiles.reduce((s, f) => s + f.tokens, 0);
  if (surface.memoryFiles.length > 2 || memTokens > 1500) {
    const savings = stats.hasData ? Math.round(memTokens * 0.5) : Math.round(memTokens * 0.5);
    const topMem = [...surface.memoryFiles].sort((a, b) => b.tokens - a.tokens).slice(0, 3);

    proposals.push({
      id: 'memory-compact',
      priority: memTokens > 3000 ? 'HIGH' : 'MEDIUM',
      category: 'memory',
      title: 'Compact Claude memory files — remove code blocks and duplicates',
      currentState:
        `${surface.memoryFiles.length} memory files, ~${memTokens} tokens loaded every session. ` +
        `Largest: ${topMem.map(f => `${f.relPath} (${f.tokens}t)`).join(', ')}.`,
      proposedChange:
        'Strip code blocks from memory files (code belongs in source, not memory), ' +
        'remove lines already covered by CLAUDE.md, collapse multi-line paragraphs to single facts. ' +
        `Estimated reduction: ${memTokens} → ~${Math.round(memTokens * 0.5)} tokens.`,
      estimatedSavingsPct: Math.round((savings / (avgTokens || memTokens)) * 100),
      estimatedSavingsTokensPerSession: savings,
      howToApply: 'Run: npx openeral optimize apply --proposal memory-compact',
      canAutoApply: true,
    });
  }

  // ── 6. Cache ordering ─────────────────────────────────────────────────────
  if (stats.hasData && stats.cacheHitRate < 25 && stats.totalApiCalls >= 5) {
    proposals.push({
      id: 'cache-ordering',
      priority: 'MEDIUM',
      category: 'caching',
      title: 'Improve cache hit rate by reordering CLAUDE.md sections',
      currentState:
        `Cache hit rate: ${stats.cacheHitRate}% (${stats.totalApiCalls} calls). ` +
        'Anthropic prompt caching requires stable content at the start of every prompt. ' +
        'If CLAUDE.md has volatile content near the top, cache entries get invalidated every call.',
      proposedChange:
        'Reorder CLAUDE.md: hard rules and conventions at the top (stable, cacheable), ' +
        'session-specific notes and recent context at the bottom (volatile). ' +
        'Target: >50% cache hit rate, saving ~90% on cached input tokens.',
      estimatedSavingsPct: 12,
      estimatedSavingsTokensPerSession: stats.hasData ? Math.round(avgTokens * 0.12) : 0,
      howToApply: 'Review CLAUDE.md and move stable sections (rules, conventions) above dynamic ones.',
      canAutoApply: false,
    });
  }

  // Sort: HIGH first, then by estimated savings
  return proposals.sort((a, b) => {
    const pri = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    if (pri[a.priority] !== pri[b.priority]) return pri[a.priority] - pri[b.priority];
    return b.estimatedSavingsTokensPerSession - a.estimatedSavingsTokensPerSession;
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function analyzePromptSurface(opts: AnalyzeOptions = {}): Promise<StrategicReport> {
  const workspaceId = opts.workspaceId ?? process.env.OPENERAL_WORKSPACE_ID ?? hostname();
  const startDir = opts.projectRoot ? resolve(opts.projectRoot) : process.cwd();
  const daysBack = opts.daysBack ?? 7;

  const projectRoot = detectProjectRoot(startDir);
  const memoryDir = detectMemoryDir(projectRoot, workspaceId);

  const [sessionStats, promptSurface, hotspots] = await Promise.all([
    opts.pool
      ? querySessionStats(opts.pool, workspaceId, daysBack)
      : Promise.resolve(emptySessionStats(daysBack)),
    Promise.resolve(analyzePromptSurfaceFiles(projectRoot, memoryDir)),
    findActualHotspots(opts.pool, workspaceId, daysBack, projectRoot),
  ]);

  const proposals = buildProposals(sessionStats, promptSurface, projectRoot);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    memoryDir,
    sessionStats,
    promptSurface,
    proposals,
    hotspots,
  };
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

export function formatPromptSurfaceReport(report: StrategicReport): string {
  const lines: string[] = [];
  const { sessionStats: s, promptSurface: p } = report;

  lines.push('# Openeral Token Analysis Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Project:   ${report.projectRoot}`);
  lines.push(`Memory:    ${report.memoryDir ?? '(not found)'}`);
  lines.push('');

  // ── Session summary ────────────────────────────────────────────────────────
  if (s.hasData) {
    lines.push('## Session Summary  (' + s.period + ')');
    lines.push('');
    lines.push(`  Sessions analyzed:    ${s.sessionsAnalyzed}`);
    lines.push(`  Total tokens used:    ${s.totalTokens.toLocaleString()}`);
    lines.push(`  Total API calls:      ${s.totalApiCalls}`);
    lines.push(`  Total cost:           $${s.totalCost.toFixed(6)}`);
    lines.push(`  Avg tokens/session:   ${s.avgTokensPerSession.toLocaleString()}`);
    lines.push(`  Avg tokens/call:      ${s.avgTokensPerCall.toLocaleString()}`);
    lines.push(`  Avg calls/session:    ${s.avgCallsPerSession}`);
    lines.push(`  Cache hit rate:       ${s.cacheHitRate}%`);
    lines.push('');

    if (s.models.length > 0) {
      lines.push('  Model usage:');
      for (const m of s.models) {
        lines.push(`    ${m.displayName.padEnd(8)} ${m.calls} calls  ${m.tokens.toLocaleString()} tokens  (${m.pct}%)`);
      }
      lines.push('');
    }

    if (s.tasks.length > 0) {
      lines.push('  Task breakdown:');
      for (const t of s.tasks) {
        const wasted = t.wastedOnExpensiveModel > 0 ? `  ⚠ ${t.wastedOnExpensiveModel} used expensive model` : '';
        lines.push(`    ${t.taskType.padEnd(15)} ${t.calls} calls  ${t.tokens.toLocaleString()} tokens${wasted}`);
      }
      lines.push('');
    }
  } else {
    lines.push('## Session Summary');
    lines.push('');
    lines.push('  No session data yet. Run a Claude Code session via `npx openeral` to collect data.');
    lines.push('  Proposals below are based on project file analysis.');
    lines.push('');
  }

  // ── Prompt surface ────────────────────────────────────────────────────────
  lines.push('## Prompt Surface (loaded every session)');
  lines.push('');
  lines.push(`  Total always-loaded tokens: ~${p.totalTokens}`);
  if (p.instructionFiles.length > 0) {
    lines.push('  Instruction files:');
    for (const f of p.instructionFiles) {
      lines.push(`    ${f.relPath.padEnd(30)} ~${f.tokens} tokens`);
    }
  }
  if (p.memoryFiles.length > 0) {
    lines.push('  Memory files:');
    for (const f of p.memoryFiles) {
      lines.push(`    ${f.relPath.padEnd(30)} ~${f.tokens} tokens`);
    }
  }
  lines.push('');

  // ── Proposals ────────────────────────────────────────────────────────────
  lines.push('## Proposals  (ranked by impact)');
  lines.push('');

  if (report.proposals.length === 0) {
    if (s.hasData && s.avgTokensPerSession < 2000) {
      lines.push('  ✓ Your sessions are already efficient!');
      lines.push(`  ✓ Average ${s.avgTokensPerSession} tokens/session is excellent for your workload.`);
      lines.push('  ✓ No optimizations needed at this time.');
    } else {
      lines.push('  ✓ All major optimizations are already in place.');
    }
  } else {
    const totalSavings = report.proposals.reduce((s, p) => s + p.estimatedSavingsTokensPerSession, 0);
    if (totalSavings > 0) {
      lines.push(`  Potential total savings: ~${totalSavings.toLocaleString()} tokens/session`);
      lines.push('');
    }

    for (let i = 0; i < report.proposals.length; i++) {
      const prop = report.proposals[i];
      const icon = prop.priority === 'HIGH' ? '🔴' : prop.priority === 'MEDIUM' ? '🟡' : '🟢';
      const applyTag = prop.canAutoApply ? '  [auto-apply available]' : '  [manual]';

      lines.push(`${icon} ${prop.priority} — ${prop.title}${applyTag}`);
      lines.push('');
      lines.push(`   Now:     ${prop.currentState}`);
      lines.push(`   Change:  ${prop.proposedChange}`);
      if (prop.estimatedSavingsTokensPerSession > 0) {
        lines.push(`   Savings: ~${prop.estimatedSavingsTokensPerSession.toLocaleString()} tokens/session (${prop.estimatedSavingsPct}%)`);
      }
      lines.push(`   Apply:   ${prop.howToApply}`);
      lines.push('');
    }
  }

  // ── Hotspots ──────────────────────────────────────────────────────────────
  lines.push('## Large Files Read During Sessions');
  lines.push('');
  if (report.hotspots === null) {
    // StringCost proxy logs token counts per API call but not which files were read.
    // File-path tracking was only available in the old proxy-based optimizer.
    lines.push('  ⚠ File access data is not available with the current tracking setup.');
    lines.push('  StringCost records token counts per API call but does not track which');
    lines.push('  individual files Claude read inside each call.');
    lines.push('  If your sessions are reading many large files, this section will remain empty.');
    if (s.hasData && s.avgTokensPerCall > 1000) {
      lines.push('');
      lines.push(`  ℹ Your avg ${s.avgTokensPerCall.toLocaleString()} tokens/call suggests files may be`);
      lines.push('  read in full. Consider adding lazy-reading rules (npx openeral apply --proposal lazy-reading).');
    }
  } else if (report.hotspots.length > 0) {
    lines.push('  These files were read during your sessions and are expensive (>1000 tokens each).');
    lines.push('  Consider using Grep to find specific sections instead of reading the full file.');
    for (const h of report.hotspots) {
      lines.push(`    ${h.relPath.padEnd(50)} ~${h.tokens} tokens`);
    }
  } else {
    lines.push('  ✓ No large files (>1000 tokens) were read during your sessions.');
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  dryRun?: boolean;
  proposals?: string[]; // specific proposal IDs, or undefined = all auto-applicable
}

export async function applyRecommendations(
  report: StrategicReport,
  opts: ApplyOptions = {},
): Promise<void> {
  const { dryRun = false } = opts;
  const targets = opts.proposals?.length
    ? report.proposals.filter(p => opts.proposals!.includes(p.id))
    : report.proposals.filter(p => p.canAutoApply);

  if (targets.length === 0) {
    console.log('No auto-applicable proposals to apply.');
    return;
  }

  const prefix = dryRun ? '[DRY RUN] ' : '';
  console.log(`${prefix}Applying ${targets.length} proposal${targets.length === 1 ? '' : 's'}...\n`);

  for (const proposal of targets) {
    console.log(`▶ ${proposal.title}`);
    try {
      await applyProposal(proposal, report, dryRun);
    } catch (err: any) {
      console.log(`  ⚠ Failed: ${err.message}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Run without --dry-run to apply these changes.');
  } else {
    const totalSaved = targets.reduce((s, p) => s + p.estimatedSavingsTokensPerSession, 0);
    console.log(`Done. Estimated savings: ~${totalSaved.toLocaleString()} tokens/session.`);
  }
}

// ---------------------------------------------------------------------------
// Individual proposal apply handlers
// ---------------------------------------------------------------------------

async function applyProposal(
  proposal: Proposal,
  report: StrategicReport,
  dryRun: boolean,
): Promise<void> {
  switch (proposal.id) {
    case 'model-routing':
      return applyModelRouting(report.projectRoot, dryRun);
    case 'context-file':
      return applyContextFile(report.projectRoot, dryRun);
    case 'readme-updates':
      return applyReadmeUpdates(report.projectRoot, dryRun);
    case 'lazy-reading':
      return applyLazyReading(report.projectRoot, dryRun);
    case 'memory-compact':
      return applyMemoryCompact(report, dryRun);
    default:
      console.log(`  Proposal '${proposal.id}' has no auto-apply handler.`);
  }
}

const SECTION_FENCE = '<!-- openeral-optimizer -->';

function patchClaudeMd(projectRoot: string, sectionId: string, newBlock: string, dryRun: boolean): void {
  const claudePath = join(projectRoot, 'CLAUDE.md');
  let existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';

  // Remove old block if present (idempotent)
  const startTag = `${SECTION_FENCE}:${sectionId}:start`;
  const endTag = `${SECTION_FENCE}:${sectionId}:end`;
  const taggedRe = new RegExp(`\\n?${escapeRe(startTag)}[\\s\\S]*?${escapeRe(endTag)}\\n?`, 'g');
  existing = existing.replace(taggedRe, '');

  const block = `\n${startTag}\n${newBlock}\n${endTag}\n`;
  const updated = existing.trimEnd() + '\n' + block;

  console.log(`  → ${dryRun ? 'Would patch' : 'Patching'} ${claudePath}`);
  if (!dryRun) writeFileSync(claudePath, updated, 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyModelRouting(projectRoot: string, dryRun: boolean): void {
  const block = `## Model Selection

To minimize token costs, pick the most efficient model for each task:

- **Haiku** (\`claude-haiku-4-5\`): file reads, searches, grep, simple questions, bash one-liners
- **Sonnet** (\`claude-sonnet-4-6\`): code edits, refactors, multi-file tasks, debugging
- **Opus**: avoid unless the task requires complex multi-step reasoning with no clear approach

Switch model with \`/model <model-id>\` at the start of a session, or set \`ANTHROPIC_MODEL\` env var.
Analyze the user's request first — default to Haiku, upgrade only if the task genuinely needs it.`;

  patchClaudeMd(projectRoot, 'model-routing', block, dryRun);
  console.log('  → Model routing rules added. Haiku for simple tasks, Sonnet for coding.');
}

function applyContextFile(projectRoot: string, dryRun: boolean): void {
  const dotClaudeDir = join(projectRoot, '.claude');
  const contextPath = join(dotClaudeDir, 'CONTEXT.md');

  if (!dryRun) {
    mkdirSync(dotClaudeDir, { recursive: true });
    if (!existsSync(contextPath)) {
      writeFileSync(contextPath, `# Project Context

> Claude: read this at the start of every session. Update it after completing significant tasks.

## Current State
<!-- What is currently working / in progress -->
(not yet populated — Claude will update this after the first session)

## Recent Changes
<!-- What was last changed and why -->
(none yet)

## Active Files
<!-- Most relevant files for current work -->
(none yet)

## Known Issues / Next Steps
<!-- Blockers or planned work -->
(none yet)
`, 'utf8');
      console.log(`  → Created ${contextPath}`);
    } else {
      console.log(`  → ${contextPath} already exists, skipping creation.`);
    }
  } else {
    console.log(`  → Would create ${contextPath}`);
  }

  const block = `## Context File

At the start of each session, read \`.claude/CONTEXT.md\` for current project state.
After completing a significant task, update \`.claude/CONTEXT.md\`:
- Update "Current State" with what is now working
- Add a line to "Recent Changes" describing what you changed and why
- Update "Active Files" if the relevant files changed

This keeps future sessions efficient — read the context file instead of re-exploring source files.`;

  patchClaudeMd(projectRoot, 'context-file', block, dryRun);
  console.log('  → Context file instruction added to CLAUDE.md.');
}

function applyReadmeUpdates(projectRoot: string, dryRun: boolean): void {
  const block = `## README Maintenance

After completing a coding task that changes the project's behavior, API, or structure:
1. Update the relevant section of \`README.md\` to reflect the change.
2. Keep the README accurate so future sessions can read it for context instead of exploring source files.

Do not update README for minor internal refactors — only for changes that affect how the project is used or understood.`;

  patchClaudeMd(projectRoot, 'readme-updates', block, dryRun);
  console.log('  → README maintenance instruction added to CLAUDE.md.');
}

function applyLazyReading(projectRoot: string, dryRun: boolean): void {
  const block = `## File Reading Strategy

To avoid wasting tokens on large files:
- Before reading any file, check if the needed information is already in your context.
- Use \`Grep\` to find the relevant section/function before doing a full \`Read\`.
- Use \`Glob\` to identify which file to read rather than reading several candidates.
- When using \`Read\`, specify \`offset\` and \`limit\` to read only the relevant lines.
- Never read \`pnpm-lock.yaml\`, \`Cargo.lock\`, \`package-lock.json\`, or other lock files — they are never useful for coding tasks.`;

  patchClaudeMd(projectRoot, 'lazy-reading', block, dryRun);
  console.log('  → Lazy file-reading rules added to CLAUDE.md.');
}

function applyMemoryCompact(report: StrategicReport, dryRun: boolean): void {
  if (!report.memoryDir) {
    console.log('  No memory directory found — skipping.');
    return;
  }

  // Load CLAUDE.md lines as the authority set
  const claudeLines = new Set<string>();
  for (const f of report.promptSurface.instructionFiles) {
    const content = readFile(join(report.projectRoot, f.relPath));
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.length > 5) claudeLines.add(t);
    }
  }

  const names = readdirSync(report.memoryDir)
    .filter((n): n is string => typeof n === 'string' && n.endsWith('.md'))
    .sort();

  let totalRemoved = 0;
  const seenLines = new Set<string>(claudeLines);

  for (const name of names) {
    const fullPath = join(report.memoryDir!, name);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (!stat.isFile()) continue;

    let content: string;
    try { content = readFileSync(fullPath, 'utf8'); } catch { continue; }

    const rawLines = content.split('\n');
    const kept: string[] = [];
    let removed = 0;
    let inCodeBlock = false;

    for (const line of rawLines) {
      // Track code block fences
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        // Skip both the fence and everything inside — code doesn't belong in memory
        removed++;
        continue;
      }
      if (inCodeBlock) { removed++; continue; }

      const t = line.trim();
      if (t.length > 5 && seenLines.has(t)) {
        // Duplicate of CLAUDE.md or earlier memory file
        removed++;
      } else {
        kept.push(line);
        if (t.length > 5) seenLines.add(t);
      }
    }

    if (removed === 0) {
      console.log(`  ${name}: no changes`);
      continue;
    }

    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    const newContent = kept.join('\n') + '\n';
    const savedTokens = estimateTokens(content) - estimateTokens(newContent);

    totalRemoved += removed;
    console.log(`  ${name}: removed ${removed} lines, saved ~${savedTokens} tokens`);

    if (!dryRun) writeFileSync(fullPath, newContent, 'utf8');
  }

  console.log(`  Total: ${totalRemoved} lines removed across ${names.length} memory files.`);
}
