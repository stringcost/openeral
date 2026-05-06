import type {
  CommitResult,
  Memory,
  MemoryMetadata,
  OpenVikingConfig,
  OpenVikingStatus,
  SearchOptions,
  Session,
} from './types.js';

export class OpenVikingClient {
  private endpoint: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private agentId: string;

  // Circuit breaker state
  private failureCount = 0;
  private lastFailureAt = 0;
  private readonly CIRCUIT_RESET_MS = 60_000;
  private readonly CIRCUIT_OPEN_THRESHOLD = 3;

  constructor(config: OpenVikingConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.agentId = config.agentId;
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount < this.CIRCUIT_OPEN_THRESHOLD) return false;
    return Date.now() - this.lastFailureAt < this.CIRCUIT_RESET_MS;
  }

  private onSuccess(): void {
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    if (this.isCircuitOpen()) throw new Error('OpenViking circuit breaker open');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.endpoint}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) {
        this.onFailure();
        throw new Error(`OpenViking ${init.method ?? 'GET'} ${path} failed: HTTP ${res.status}`);
      }
      this.onSuccess();
      return res.json() as Promise<T>;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Memory[]> {
    const data = await this.fetchJson<{ memories: Memory[] }>('/v1/memories/search', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        query,
        agent_id: this.agentId,
        uri: opts.uri,
        limit: opts.limit ?? 10,
        score_threshold: opts.scoreThreshold,
      }),
    });
    return data.memories ?? [];
  }

  async store(content: string, metadata: MemoryMetadata = {}): Promise<void> {
    await this.fetchJson<unknown>('/v1/memories', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content, agent_id: this.agentId, metadata }),
    });
  }

  async forget(uri: string): Promise<void> {
    await this.fetchJson<unknown>(`/v1/memories/${encodeURIComponent(uri)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  async createSession(sessionId: string): Promise<Session> {
    return this.fetchJson<Session>('/v1/sessions', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId, agent_id: this.agentId }),
    });
  }

  async appendToSession(sessionId: string, content: string): Promise<void> {
    await this.fetchJson<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content }),
    });
  }

  async commitSession(sessionId: string, wait = false): Promise<CommitResult> {
    return this.fetchJson<CommitResult>(`/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ wait }),
    });
  }

  async isAvailable(): Promise<boolean> {
    if (this.isCircuitOpen()) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.endpoint}/v1/health`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: controller.signal,
      });
      if (res.ok) this.onSuccess();
      return res.ok;
    } catch {
      this.onFailure();
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async getStatus(): Promise<OpenVikingStatus> {
    const start = Date.now();
    const healthy = await this.isAvailable();
    const latencyMs = Date.now() - start;

    if (!healthy) {
      return { connected: false, healthy: false, latencyMs, endpoint: this.endpoint };
    }

    try {
      const stats = await this.fetchJson<{
        user_memories?: number;
        agent_memories?: number;
        session_archives?: number;
        resources?: number;
      }>('/v1/stats', { method: 'GET', headers: this.headers() });

      return {
        connected: true,
        healthy: true,
        latencyMs,
        endpoint: this.endpoint,
        userMemories: stats.user_memories,
        agentMemories: stats.agent_memories,
        sessionArchives: stats.session_archives,
        resources: stats.resources,
      };
    } catch {
      return { connected: true, healthy: true, latencyMs, endpoint: this.endpoint };
    }
  }
}

export function createOpenVikingClient(config: OpenVikingConfig): OpenVikingClient | null {
  if (!config.enabled) return null;
  return new OpenVikingClient(config);
}
