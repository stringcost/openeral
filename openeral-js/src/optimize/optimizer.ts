/**
 * Main optimizer that coordinates all optimization strategies
 */

import type { DbPool } from '../db/pool.js';
import type { APIRequest, APIResponse, OptimizerConfig, OptimizationMetrics } from './types.js';
import { DEFAULT_OPTIMIZER_CONFIG } from './types.js';
import { analyzeTask, selectOptimalModel } from './task-analyzer.js';
import { compressPrompt, estimateRequestTokens } from './prompt-compressor.js';
import { enablePromptCaching, generateCacheKey, getCachedResponse, setCachedResponse } from './caching.js';
import { calculateCost, storeMetrics } from './metrics.js';

export class Optimizer {
  private pool: DbPool;
  private workspaceId: string;
  private config: OptimizerConfig;

  constructor(pool: DbPool, workspaceId: string, config: Partial<OptimizerConfig> = {}) {
    this.pool = pool;
    this.workspaceId = workspaceId;
    this.config = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
  }

  /**
   * Optimize an API request before sending
   */
  async optimizeRequest(request: APIRequest): Promise<{
    request: APIRequest;
    cacheHit: boolean;
    cachedResponse?: APIResponse;
    metrics: OptimizationMetrics;
  }> {
    if (!this.config.enabled) {
      // Pass through without optimization
      const tokens = estimateRequestTokens(request);
      return {
        request,
        cacheHit: false,
        metrics: this.createPassthroughMetrics(request, tokens),
      };
    }

    const originalRequest = JSON.parse(JSON.stringify(request)); // Deep clone
    const originalTokens = estimateRequestTokens(originalRequest);
    const originalModel = originalRequest.model || 'claude-3-5-sonnet-20241022';
    
    let optimizedRequest = { ...request };
    const optimizationsApplied: string[] = [];

    // 1. Check local cache first
    let cacheHit = false;
    let cachedResponse: APIResponse | undefined;
    
    if (this.config.localCaching) {
      const cacheKey = generateCacheKey(request);
      const cached = await getCachedResponse(this.pool, cacheKey, this.config.cacheTimeoutMs);
      
      if (cached) {
        cacheHit = true;
        cachedResponse = cached;
        optimizationsApplied.push('local_cache');
        
        // Return cached response with metrics
        const metrics = this.createCacheHitMetrics(originalRequest, originalTokens, originalModel);
        return { request: optimizedRequest, cacheHit: true, cachedResponse, metrics };
      }
    }

    // 2. Analyze task and select optimal model
    if (this.config.modelRouting) {
      const task = analyzeTask(request);
      const optimalModel = selectOptimalModel(task, this.config.preferHaiku);
      
      if (optimalModel !== originalModel) {
        optimizedRequest.model = optimalModel;
        optimizationsApplied.push('model_routing');
      }
    }

    // 3. Compress prompt
    if (this.config.promptCompression) {
      const compressed = compressPrompt(optimizedRequest);
      const compressedTokens = estimateRequestTokens(compressed);
      
      if (compressedTokens < originalTokens) {
        optimizedRequest = compressed;
        optimizationsApplied.push('prompt_compression');
      }
    }

    // 4. Enable prompt caching
    if (this.config.promptCaching) {
      optimizedRequest = enablePromptCaching(optimizedRequest);
      optimizationsApplied.push('prompt_caching');
    }

    // Calculate metrics
    const optimizedTokens = estimateRequestTokens(optimizedRequest);
    const optimizedModel = optimizedRequest.model || 'claude-3-5-sonnet-20241022';
    
    const task = analyzeTask(request);
    const metrics: OptimizationMetrics = {
      workspaceId: this.workspaceId,
      timestamp: new Date(),
      originalModel,
      originalPromptTokens: originalTokens,
      originalEstimatedCost: calculateCost(originalModel, originalTokens),
      optimizedModel,
      optimizedPromptTokens: optimizedTokens,
      optimizedActualCost: calculateCost(optimizedModel, optimizedTokens),
      optimizationsApplied,
      taskType: task.type,
      cacheHit: false,
      tokensSaved: originalTokens - optimizedTokens,
      costSaved: calculateCost(originalModel, originalTokens) - calculateCost(optimizedModel, optimizedTokens),
      savingsPercentage: originalTokens > 0 
        ? ((originalTokens - optimizedTokens) / originalTokens) * 100 
        : 0,
    };

    return { request: optimizedRequest, cacheHit: false, metrics };
  }

  /**
   * Store response in cache and record metrics
   */
  async recordResponse(
    request: APIRequest,
    response: APIResponse,
    metrics: OptimizationMetrics
  ): Promise<void> {
    // Update metrics with actual usage from response
    if (response.usage) {
      metrics.optimizedPromptTokens = response.usage.input_tokens;
      metrics.optimizedActualCost = calculateCost(
        metrics.optimizedModel,
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      
      // Recalculate savings
      metrics.tokensSaved = metrics.originalPromptTokens - response.usage.input_tokens;
      metrics.costSaved = metrics.originalEstimatedCost - metrics.optimizedActualCost;
      metrics.savingsPercentage = metrics.originalPromptTokens > 0
        ? (metrics.tokensSaved / metrics.originalPromptTokens) * 100
        : 0;
    }

    // Store metrics
    await storeMetrics(this.pool, metrics);

    // Cache response
    if (this.config.localCaching && !metrics.cacheHit) {
      const cacheKey = generateCacheKey(request);
      await setCachedResponse(this.pool, cacheKey, response);
    }
  }

  private createPassthroughMetrics(request: APIRequest, tokens: number): OptimizationMetrics {
    const model = request.model || 'claude-3-5-sonnet-20241022';
    const cost = calculateCost(model, tokens);
    
    return {
      workspaceId: this.workspaceId,
      timestamp: new Date(),
      originalModel: model,
      originalPromptTokens: tokens,
      originalEstimatedCost: cost,
      optimizedModel: model,
      optimizedPromptTokens: tokens,
      optimizedActualCost: cost,
      optimizationsApplied: [],
      taskType: 'unknown',
      cacheHit: false,
      tokensSaved: 0,
      costSaved: 0,
      savingsPercentage: 0,
    };
  }

  private createCacheHitMetrics(request: APIRequest, tokens: number, model: string): OptimizationMetrics {
    const cost = calculateCost(model, tokens);
    
    return {
      workspaceId: this.workspaceId,
      timestamp: new Date(),
      originalModel: model,
      originalPromptTokens: tokens,
      originalEstimatedCost: cost,
      optimizedModel: model,
      optimizedPromptTokens: 0, // No API call made
      optimizedActualCost: 0, // No cost
      optimizationsApplied: ['local_cache'],
      taskType: 'cached',
      cacheHit: true,
      tokensSaved: tokens,
      costSaved: cost,
      savingsPercentage: 100,
    };
  }
}

/**
 * Create optimizer instance
 */
export function createOptimizer(
  pool: DbPool,
  workspaceId: string,
  config?: Partial<OptimizerConfig>
): Optimizer {
  return new Optimizer(pool, workspaceId, config);
}
