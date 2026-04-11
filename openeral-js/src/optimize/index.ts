/**
 * Openeral Optimizer - Active token and cost optimization
 */

export { Optimizer, createOptimizer } from './optimizer.js';
export { analyzeTask, selectOptimalModel } from './task-analyzer.js';
export { compressPrompt, estimateRequestTokens } from './prompt-compressor.js';
export { enablePromptCaching, generateCacheKey, getCachedResponse, setCachedResponse } from './caching.js';
export { calculateCost, storeMetrics, getOptimizationStats, formatStats } from './metrics.js';
export { OptimizerProxy, startProxy } from './proxy.js';
export { analyzeUsage, formatAnalysisReport } from './analyzer.js';
export type {
  APIRequest,
  APIResponse,
  Message,
  ContentBlock,
  SystemMessage,
  TaskAnalysis,
  OptimizationResult,
  OptimizationMetrics,
  OptimizerConfig,
  ModelName,
} from './types.js';
export { DEFAULT_OPTIMIZER_CONFIG, MODEL_PRICING } from './types.js';
