/**
 * Lightweight logging proxy for Anthropic API calls.
 *
 * Intercepts every /v1/messages request made by Claude Code, saves the token
 * usage to the local database in real-time, and forwards the request to the
 * real Anthropic API (or a StringCost proxy URL if configured).
 *
 * Handles both streaming (text/event-stream) and non-streaming responses so
 * that Claude Code's behaviour is never affected.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { DbPool } from '../db/pool.js';
import type { APIRequest } from './types.js';
import { calculateCost, storeMetrics } from './metrics.js';

export interface ProxyConfig {
  /** Port to listen on. 0 = let the OS pick a free port (recommended). */
  port?: number;
  /** Anthropic API key forwarded upstream. */
  anthropicApiKey: string;
  /** Upstream base URL, e.g. 'https://api.anthropic.com' or a StringCost URL. */
  anthropicBaseUrl: string;
  /** DB pool for saving metrics. null = run without DB (passthrough only). */
  pool: DbPool | null;
  /** Workspace ID recorded in every metric row. */
  workspaceId: string;
  /** Session ID recorded in metadata so stats can be grouped per session. */
  sessionId?: string;
}

export class OptimizerProxy {
  private config: ProxyConfig;
  private server: Server | null = null;
  private _port = 0;
  /** Pending storeMetrics promises — tracked so drain() can await them all. */
  private _pendingSaves: Set<Promise<void>> = new Set();

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  /** Actual port assigned after start(). */
  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
          }
          if (!res.writableEnded) {
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      this.server.listen(this.config.port ?? 0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Wait for all in-flight storeMetrics calls to settle, then close the server.
   * Call this before ending the DB pool to avoid writes against a closed pool.
   */
  async drain(): Promise<void> {
    if (this._pendingSaves.size > 0) {
      await Promise.allSettled(this._pendingSaves);
    }
    await new Promise<void>(resolve => {
      if (!this.server) { resolve(); return; }
      const s = this.server;
      this.server = null;
      s.close(() => resolve());
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const isMessages = req.method === 'POST' && (req.url ?? '').includes('/v1/messages');

    if (!isMessages) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const rawBody = await readBody(req);

    let request: APIRequest;
    try {
      request = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request' }));
      return;
    }

    const upstreamUrl = `${this.config.anthropicBaseUrl}/v1/messages`;

    // Forward the essential Anthropic headers
    const upstreamHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
      'x-api-key': this.config.anthropicApiKey,
    };

    // Pass through anthropic-beta and other anthropic-* headers
    for (const [key, val] of Object.entries(req.headers)) {
      if (key.startsWith('anthropic-') && key !== 'anthropic-version') {
        upstreamHeaders[key] = String(Array.isArray(val) ? val.join(', ') : (val ?? ''));
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: rawBody,
      });
    } catch (err: any) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
      return;
    }

    if (!upstream.ok) {
      const errorText = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(errorText);
      return;
    }

    const isStreaming = request.stream === true;

    if (isStreaming) {
      await this.handleStreaming(request, upstream, res);
    } else {
      await this.handleNonStreaming(request, upstream, res);
    }
  }

  // -------------------------------------------------------------------------
  // Streaming response (SSE passthrough + usage extraction)
  // -------------------------------------------------------------------------

  private async handleStreaming(
    request: APIRequest,
    upstream: Response,
    clientRes: ServerResponse,
  ): Promise<void> {
    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });

    let model = request.model ?? 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let sseBuffer = '';

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      clientRes.write(chunk);

      // Parse SSE events to extract token counts
      sseBuffer += chunk;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === 'message_start' && event.message) {
            model = event.message.model ?? model;
            const u = event.message.usage ?? {};
            inputTokens = u.input_tokens ?? 0;
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          } else if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }
        } catch {
          // Ignore parse errors on individual SSE lines
        }
      }
    }

    clientRes.end();

    this.saveUsage(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
  }

  // -------------------------------------------------------------------------
  // Non-streaming response (buffer + log)
  // -------------------------------------------------------------------------

  private async handleNonStreaming(
    request: APIRequest,
    upstream: Response,
    clientRes: ServerResponse,
  ): Promise<void> {
    const data = await upstream.json() as Record<string, any>;

    clientRes.writeHead(200, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify(data));

    const model = String(data.model ?? request.model ?? 'unknown');
    const u = (data.usage ?? {}) as Record<string, number>;

    this.saveUsage(
      model,
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
    );
  }

  // -------------------------------------------------------------------------
  // Persist usage to DB (fire-and-forget, never throws)
  // -------------------------------------------------------------------------

  private saveUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): void {
    if (!this.config.pool || inputTokens === 0) return;

    const cost = calculateCost(model, inputTokens, outputTokens);

    const save = storeMetrics(this.config.pool, {
      workspaceId: this.config.workspaceId,
      timestamp: new Date(),
      originalModel: model,
      originalPromptTokens: inputTokens,
      originalEstimatedCost: cost,
      optimizedModel: model,
      optimizedPromptTokens: inputTokens,
      optimizedActualCost: cost,
      optimizationsApplied: [],
      taskType: 'unknown',
      cacheHit: cacheReadTokens > 0,
      tokensSaved: 0,
      costSaved: 0,
      savingsPercentage: 0,
      metadata: {
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        session_id: this.config.sessionId,
      },
    }).catch((err: Error) => {
      // Non-fatal — never block the response
      process.stderr.write(`openeral: failed to log usage: ${err.message}\n`);
    }) as Promise<void>;

    // Track so drain() can wait for this write before pool.end()
    this._pendingSaves.add(save);
    save.finally(() => this._pendingSaves.delete(save));
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Start a proxy and return it.
 * Compatible shim for proxy-cli.ts which calls startProxy({ port, ... }).
 */
export async function startProxy(config: Partial<ProxyConfig> & { port?: number; optimizerEnabled?: boolean } = {}): Promise<OptimizerProxy> {
  const proxy = new OptimizerProxy({
    port: config.port,
    anthropicApiKey: config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: config.anthropicBaseUrl ?? 'https://api.anthropic.com',
    pool: config.pool ?? null,
    workspaceId: config.workspaceId ?? process.env.OPENERAL_WORKSPACE_ID ?? 'default',
    sessionId: config.sessionId,
  });
  await proxy.start();
  return proxy;
}
