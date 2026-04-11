/**
 * Track optimization metrics for proof and validation
 */

import type { DbPool } from '../db/pool.js';
import type { OptimizationMetrics } from './types.js';
import { MODEL_PRICING, type ModelName } from './types.js';

/**
 * Calculate estimated cost for a request
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number = 0): number {
  const pricing = MODEL_PRICING[model as ModelName];
  if (!pricing) {
    // Default to Sonnet pricing if model not found
    return (inputTokens * 3.00 + outputTokens * 15.00) / 1_000_000;
  }
  
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Store optimization metrics
 */
export async function storeMetrics(pool: DbPool, metrics: OptimizationMetrics): Promise<void> {
  await pool.query(
    `INSERT INTO _openeral.optimization_metrics (
      workspace_id, timestamp, original_model, original_prompt_tokens, 
      original_estimated_cost, optimized_model, optimized_prompt_tokens,
      optimized_actual_cost, optimizations_applied, task_type, cache_hit,
      tokens_saved, cost_saved, savings_percentage, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      metrics.workspaceId,
      metrics.timestamp,
      metrics.originalModel,
      metrics.originalPromptTokens,
      metrics.originalEstimatedCost,
      metrics.optimizedModel,
      metrics.optimizedPromptTokens,
      metrics.optimizedActualCost,
      metrics.optimizationsApplied,
      metrics.taskType,
      metrics.cacheHit,
      metrics.tokensSaved,
      metrics.costSaved,
      metrics.savingsPercentage,
      JSON.stringify(metrics.metadata || {}),
    ]
  );
}

/**
 * Get optimization statistics for a workspace
 */
export async function getOptimizationStats(
  pool: DbPool,
  workspaceId: string,
  daysBack: number = 7
): Promise<{
  totalCostWithout: number;
  totalCostWith: number;
  totalSaved: number;
  savingsPercentage: number;
  totalTokensOriginal: number;
  totalTokensOptimized: number;
  tokensSaved: number;
  apiCallsMade: number;
  cacheHits: number;
  modelDistribution: Record<string, number>;
  optimizationBreakdown: Record<string, number>;
}> {
  const result = await pool.query(
    `SELECT 
      SUM(original_estimated_cost) as total_cost_without,
      SUM(optimized_actual_cost) as total_cost_with,
      SUM(cost_saved) as total_saved,
      SUM(original_prompt_tokens) as total_tokens_original,
      SUM(optimized_prompt_tokens) as total_tokens_optimized,
      SUM(tokens_saved) as tokens_saved,
      COUNT(*) as api_calls_made,
      SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hits
    FROM _openeral.optimization_metrics
    WHERE workspace_id = $1
    AND timestamp > NOW() - INTERVAL '1 day' * $2`,
    [workspaceId, daysBack]
  );

  const row = result.rows[0];
  const totalCostWithout = parseFloat(row.total_cost_without || 0);
  const totalCostWith = parseFloat(row.total_cost_with || 0);
  const totalSaved = parseFloat(row.total_saved || 0);

  // Get model distribution
  const modelResult = await pool.query(
    `SELECT optimized_model, COUNT(*) as count
    FROM _openeral.optimization_metrics
    WHERE workspace_id = $1
    AND timestamp > NOW() - INTERVAL '1 day' * $2
    GROUP BY optimized_model`,
    [workspaceId, daysBack]
  );

  const modelDistribution: Record<string, number> = {};
  for (const row of modelResult.rows) {
    modelDistribution[row.optimized_model] = parseInt(row.count);
  }

  // Get optimization breakdown
  const optResult = await pool.query(
    `SELECT 
      UNNEST(optimizations_applied) as optimization,
      SUM(cost_saved) as saved
    FROM _openeral.optimization_metrics
    WHERE workspace_id = $1
    AND timestamp > NOW() - INTERVAL '1 day' * $2
    GROUP BY optimization`,
    [workspaceId, daysBack]
  );

  const optimizationBreakdown: Record<string, number> = {};
  for (const row of optResult.rows) {
    optimizationBreakdown[row.optimization] = parseFloat(row.saved || 0);
  }

  return {
    totalCostWithout,
    totalCostWith,
    totalSaved,
    savingsPercentage: totalCostWithout > 0 ? (totalSaved / totalCostWithout) * 100 : 0,
    totalTokensOriginal: parseInt(row.total_tokens_original || 0),
    totalTokensOptimized: parseInt(row.total_tokens_optimized || 0),
    tokensSaved: parseInt(row.tokens_saved || 0),
    apiCallsMade: parseInt(row.api_calls_made || 0),
    cacheHits: parseInt(row.cache_hits || 0),
    modelDistribution,
    optimizationBreakdown,
  };
}

/**
 * Format stats for display
 */
export function formatStats(stats: Awaited<ReturnType<typeof getOptimizationStats>>): string {
  const lines = [
    'Openeral Optimizer - Last 7 Days',
    '═'.repeat(60),
    '',
    'TOTAL SAVINGS',
    `  Cost without optimizer:  $${stats.totalCostWithout.toFixed(2)}`,
    `  Cost with optimizer:     $${stats.totalCostWith.toFixed(2)}`,
    `  Total saved:             $${stats.totalSaved.toFixed(2)} (${stats.savingsPercentage.toFixed(0)}% reduction)`,
    '',
    'TOKEN USAGE',
    `  Original tokens:         ${stats.totalTokensOriginal.toLocaleString()}`,
    `  Optimized tokens:        ${stats.totalTokensOptimized.toLocaleString()}`,
    `  Tokens saved:            ${stats.tokensSaved.toLocaleString()} (${((stats.tokensSaved / stats.totalTokensOriginal) * 100).toFixed(0)}% reduction)`,
    '',
    'MODEL DISTRIBUTION',
  ];

  const totalCalls = stats.apiCallsMade;
  for (const [model, count] of Object.entries(stats.modelDistribution)) {
    const percentage = ((count / totalCalls) * 100).toFixed(0);
    const modelName = model.includes('haiku') ? 'Haiku' : model.includes('sonnet') ? 'Sonnet' : 'Opus';
    lines.push(`  ${modelName}:   ${count} calls (${percentage}%)`);
  }

  lines.push('');
  lines.push('OPTIMIZATION BREAKDOWN');
  for (const [opt, saved] of Object.entries(stats.optimizationBreakdown)) {
    const percentage = ((saved / stats.totalSaved) * 100).toFixed(0);
    lines.push(`  ${opt}:  $${saved.toFixed(2)} saved (${percentage}%)`);
  }

  lines.push('');
  lines.push('CACHE PERFORMANCE');
  lines.push(`  API calls made:          ${stats.apiCallsMade}`);
  lines.push(`  Cache hits:              ${stats.cacheHits} (${((stats.cacheHits / stats.apiCallsMade) * 100).toFixed(0)}%)`);

  return lines.join('\n');
}
