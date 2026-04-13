/**
 * Response logger - captures usage data from Anthropic API responses
 * Works with both direct Anthropic calls and StringCost proxied calls
 */

import type { DbPool } from '../db/pool.js';
import type { APIResponse, OptimizationMetrics } from './types.js';
import { calculateCost } from './metrics.js';

/**
 * Log API response usage to database
 * Call this after receiving a response from Anthropic
 */
export async function logApiResponse(
  pool: DbPool,
  workspaceId: string,
  request: {
    model: string;
    messages: any[];
    system?: any;
  },
  response: APIResponse,
  metadata?: Record<string, any>
): Promise<void> {
  const { usage } = response;
  
  // Calculate costs
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  
  const totalCost = calculateCost(response.model, inputTokens, outputTokens);
  const cacheHit = cacheReadTokens > 0;
  
  // Estimate what it would have cost without optimization
  // (for now, assume same model - later we can track model routing)
  const originalCost = totalCost;
  const costSaved = 0; // Will be calculated when we add optimization
  
  const metrics: OptimizationMetrics = {
    workspaceId,
    timestamp: new Date(),
    originalModel: response.model,
    originalPromptTokens: inputTokens,
    originalEstimatedCost: originalCost,
    optimizedModel: response.model,
    optimizedPromptTokens: inputTokens,
    optimizedActualCost: totalCost,
    optimizationsApplied: [],
    taskType: detectTaskType(request),
    cacheHit,
    tokensSaved: 0,
    costSaved,
    savingsPercentage: 0,
    metadata: {
      ...metadata,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      response_id: response.id,
    },
  };
  
  try {
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
        JSON.stringify(metrics.metadata),
      ]
    );
  } catch (err: any) {
    // Don't fail the request if logging fails
    console.error(`Failed to log API response: ${err.message}`);
  }
}

/**
 * Detect task type from request
 */
function detectTaskType(request: { messages: any[]; system?: any }): string {
  const lastMessage = request.messages[request.messages.length - 1];
  const content = typeof lastMessage?.content === 'string' 
    ? lastMessage.content 
    : JSON.stringify(lastMessage?.content || '');
  
  const lower = content.toLowerCase();
  
  if (lower.includes('read') || lower.includes('cat') || lower.includes('view')) {
    return 'file_read';
  }
  if (lower.includes('write') || lower.includes('create') || lower.includes('edit')) {
    return 'file_write';
  }
  if (lower.includes('list') || lower.includes('ls') || lower.includes('find')) {
    return 'file_list';
  }
  if (lower.includes('bash') || lower.includes('command') || lower.includes('run')) {
    return 'bash';
  }
  if (lower.includes('explain') || lower.includes('why') || lower.includes('how')) {
    return 'reasoning';
  }
  
  return 'unknown';
}

/**
 * Parse Anthropic API response and extract usage
 * Handles both successful responses and errors
 */
export function parseApiResponse(responseBody: any): APIResponse | null {
  try {
    if (responseBody && responseBody.usage) {
      return responseBody as APIResponse;
    }
    return null;
  } catch {
    return null;
  }
}
