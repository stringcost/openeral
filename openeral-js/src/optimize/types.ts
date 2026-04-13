/**
 * Types for the optimization system
 */

export interface APIRequest {
  model: string;
  messages: Message[];
  system?: string | SystemMessage[];
  max_tokens?: number;
  temperature?: number;
  [key: string]: any;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  cache_control?: { type: 'ephemeral' };
  [key: string]: any;
}

export interface SystemMessage {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface APIResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  [key: string]: any;
}

export interface TaskAnalysis {
  type: 'file_read' | 'file_write' | 'file_list' | 'code_edit' | 'bash' | 'reasoning' | 'unknown';
  complexity: number; // 0-1 scale
  requiresDeepReasoning: boolean;
  estimatedTokens: number;
}

export interface OptimizationResult {
  originalModel: string;
  optimizedModel: string;
  originalTokens: number;
  optimizedTokens: number;
  optimizationsApplied: string[];
  cacheHit: boolean;
  estimatedCostSaved: number;
}

export interface OptimizationMetrics {
  id?: number;
  workspaceId: string;
  timestamp: Date;
  originalModel: string;
  originalPromptTokens: number;
  originalEstimatedCost: number;
  optimizedModel: string;
  optimizedPromptTokens: number;
  optimizedActualCost: number;
  optimizationsApplied: string[];
  taskType: string;
  cacheHit: boolean;
  tokensSaved: number;
  costSaved: number;
  savingsPercentage: number;
  metadata?: Record<string, any>;
}

export interface OptimizerConfig {
  enabled: boolean;
  modelRouting: boolean;
  promptCompression: boolean;
  promptCaching: boolean;
  localCaching: boolean;
  contextOptimization: boolean;
  preferHaiku: boolean;
  maxContextFiles: number;
  cacheTimeoutMs: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  enabled: true,
  modelRouting: true,
  promptCompression: true,
  promptCaching: true,
  localCaching: true,
  contextOptimization: true,
  preferHaiku: false,
  maxContextFiles: 10,
  cacheTimeoutMs: 3600000, // 1 hour
};

// Model pricing (per million tokens)
export const MODEL_PRICING = {
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
} as const;

export type ModelName = keyof typeof MODEL_PRICING;
