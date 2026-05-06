export interface OpenVikingConfig {
  enabled: boolean;
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  agentId: string;
  autoRecall: {
    enabled: boolean;
    limit: number;
    scoreThreshold: number;
    tokenBudget: number;
  };
  autoCapture: {
    enabled: boolean;
    mode: 'semantic' | 'keyword';
    intervalMinutes: number;
    timeoutMs: number;
  };
}

export interface Memory {
  uri: string;
  content: string;
  score: number;
  level?: number;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  createdAt: string;
}

export interface CommitResult {
  sessionId: string;
  memoriesExtracted: number;
}

export interface SearchOptions {
  uri?: string;
  limit?: number;
  scoreThreshold?: number;
}

export interface MemoryMetadata {
  uri?: string;
  source?: string;
  project?: string;
  [key: string]: unknown;
}

export interface ImportResult {
  resourceId: string;
  chunksCreated: number;
}

export interface OpenVikingStatus {
  connected: boolean;
  healthy: boolean;
  latencyMs: number;
  endpoint: string;
  userMemories?: number;
  agentMemories?: number;
  sessionArchives?: number;
  resources?: number;
}
