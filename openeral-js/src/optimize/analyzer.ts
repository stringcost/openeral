/**
 * Clawptimizer-style analyzer
 * Audits usage and provides recommendations
 */

import type { DbPool } from '../db/pool.js';
import { getOptimizationStats } from './metrics.js';

export interface AnalysisRule {
  id: string;
  category: 'cost' | 'performance' | 'configuration';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  recommendation: string;
  potentialSavings?: number;
  docUrl?: string;
}

export interface AnalysisReport {
  workspaceId: string;
  analyzedAt: Date;
  period: string;
  summary: {
    totalCost: number;
    totalTokens: number;
    apiCalls: number;
    potentialSavings: number;
  };
  issues: AnalysisRule[];
}

/**
 * Analyze usage and generate recommendations
 */
export async function analyzeUsage(
  pool: DbPool,
  workspaceId: string,
  daysBack: number = 7
): Promise<AnalysisReport> {
  const stats = await getOptimizationStats(pool, workspaceId, daysBack);
  const issues: AnalysisRule[] = [];

  // Rule 1: Expensive model for simple tasks
  const modelUsage = await pool.query(
    `SELECT 
      optimized_model,
      task_type,
      COUNT(*) as count,
      AVG(optimized_actual_cost) as avg_cost
    FROM _openeral.optimization_metrics
    WHERE workspace_id = $1
    AND timestamp > NOW() - INTERVAL '1 day' * $2
    GROUP BY optimized_model, task_type`,
    [workspaceId, daysBack]
  );

  for (const row of modelUsage.rows) {
    const model = row.optimized_model;
    const taskType = row.task_type;
    const count = parseInt(row.count);

    // Check if expensive model used for simple tasks
    if ((model.includes('opus') || model.includes('sonnet')) && 
        (taskType === 'file_read' || taskType === 'file_list' || taskType === 'bash')) {
      const potentialSavings = parseFloat(row.avg_cost) * count * 0.8; // 80% cheaper with Haiku
      
      issues.push({
        id: 'expensive-model-simple-task',
        category: 'cost',
        severity: 'warning',
        title: `Using ${model.includes('opus') ? 'Opus' : 'Sonnet'} for simple ${taskType} tasks`,
        description: `${count} ${taskType} operations used ${model}. These simple tasks could use Haiku (80% cheaper).`,
        recommendation: `Configure Claude Code to use claude-3-5-haiku for file operations and simple queries.`,
        potentialSavings,
        docUrl: 'https://docs.anthropic.com/en/docs/models-overview',
      });
    }
  }

  // Rule 2: Low cache hit rate
  if (stats.cacheHits > 0) {
    const cacheHitRate = (stats.cacheHits / stats.apiCallsMade) * 100;
    if (cacheHitRate < 20) {
      issues.push({
        id: 'low-cache-hit-rate',
        category: 'performance',
        severity: 'info',
        title: 'Low cache hit rate',
        description: `Only ${cacheHitRate.toFixed(0)}% of requests are hitting cache. This suggests repetitive queries that could be cached.`,
        recommendation: 'Enable prompt caching and increase cache timeout. Consider batching similar requests.',
        docUrl: 'https://docs.anthropic.com/en/docs/prompt-caching',
      });
    }
  }

  // Rule 3: No optimization applied
  if (stats.apiCallsMade > 0 && stats.totalSaved === 0) {
    issues.push({
      id: 'optimizer-not-active',
      category: 'configuration',
      severity: 'critical',
      title: 'Optimizer not active',
      description: 'No optimizations are being applied to your API calls. You\'re paying full price.',
      recommendation: 'Start the optimizer proxy: npx openeral proxy\nThen set: export ANTHROPIC_BASE_URL=http://localhost:8000',
      potentialSavings: stats.totalCostWith * 0.6, // Estimate 60% savings
    });
  }

  // Rule 4: High token usage
  const avgTokensPerCall = stats.totalTokensOptimized / stats.apiCallsMade;
  if (avgTokensPerCall > 5000) {
    issues.push({
      id: 'high-token-usage',
      category: 'cost',
      severity: 'warning',
      title: 'High average token usage per request',
      description: `Average ${avgTokensPerCall.toFixed(0)} tokens per request. This suggests large context windows or verbose prompts.`,
      recommendation: 'Enable prompt compression and context optimization. Review your system prompts for redundancy.',
      potentialSavings: stats.totalCostWith * 0.15, // Estimate 15% savings
    });
  }

  // Rule 5: Missing prompt caching
  const cachingEnabled = await pool.query(
    `SELECT COUNT(*) as count
    FROM _openeral.optimization_metrics
    WHERE workspace_id = $1
    AND timestamp > NOW() - INTERVAL '1 day' * $2
    AND 'prompt_caching' = ANY(optimizations_applied)`,
    [workspaceId, daysBack]
  );

  if (parseInt(cachingEnabled.rows[0].count) === 0 && stats.apiCallsMade > 10) {
    issues.push({
      id: 'missing-prompt-caching',
      category: 'cost',
      severity: 'warning',
      title: 'Prompt caching not enabled',
      description: 'Anthropic prompt caching can reduce costs by 90% on repeated context.',
      recommendation: 'Enable prompt caching in the optimizer configuration.',
      potentialSavings: stats.totalCostWith * 0.3, // Estimate 30% savings
      docUrl: 'https://docs.anthropic.com/en/docs/prompt-caching',
    });
  }

  // Calculate total potential savings
  const potentialSavings = issues.reduce((sum, issue) => sum + (issue.potentialSavings || 0), 0);

  return {
    workspaceId,
    analyzedAt: new Date(),
    period: `Last ${daysBack} days`,
    summary: {
      totalCost: stats.totalCostWith,
      totalTokens: stats.totalTokensOptimized,
      apiCalls: stats.apiCallsMade,
      potentialSavings,
    },
    issues,
  };
}

/**
 * Format analysis report for display
 */
export function formatAnalysisReport(report: AnalysisReport): string {
  const lines = [
    'Openeral Optimization Analysis',
    '═'.repeat(60),
    '',
    `Workspace: ${report.workspaceId}`,
    `Period: ${report.period}`,
    `Analyzed: ${report.analyzedAt.toLocaleString()}`,
    '',
    'SUMMARY',
    `  Total Cost:        $${report.summary.totalCost.toFixed(2)}`,
    `  Total Tokens:      ${report.summary.totalTokens.toLocaleString()}`,
    `  API Calls:         ${report.summary.apiCalls}`,
    `  Potential Savings: $${report.summary.potentialSavings.toFixed(2)}`,
    '',
  ];

  if (report.issues.length === 0) {
    lines.push('✅ No issues found! Your setup is optimized.');
    return lines.join('\n');
  }

  lines.push(`ISSUES (${report.issues.length})`);
  lines.push('');

  // Group by severity
  const critical = report.issues.filter(i => i.severity === 'critical');
  const warnings = report.issues.filter(i => i.severity === 'warning');
  const info = report.issues.filter(i => i.severity === 'info');

  for (const issue of [...critical, ...warnings, ...info]) {
    const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
    
    lines.push(`${icon}  ${issue.title}`);
    lines.push(`    ${issue.description}`);
    if (issue.potentialSavings) {
      lines.push(`    Potential savings: $${issue.potentialSavings.toFixed(2)}`);
    }
    lines.push(`    → ${issue.recommendation}`);
    if (issue.docUrl) {
      lines.push(`    📖 ${issue.docUrl}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
