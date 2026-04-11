/**
 * HTTP Proxy Server for Active Optimization
 * 
 * Intercepts Anthropic API calls, optimizes them, and forwards to the real API.
 * Run this proxy and set ANTHROPIC_BASE_URL=http://localhost:8000
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrations.js';
import { createOptimizer } from './optimizer.js';
import type { APIRequest, APIResponse } from './types.js';

interface ProxyConfig {
  port: number;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  databaseUrl?: string;
  workspaceId: string;
  optimizerEnabled: boolean;
}

export class OptimizerProxy {
  private config: ProxyConfig;
  private optimizer: any;
  private pool: any;

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  async initialize() {
    // Database is optional - proxy can work without it (no metrics storage)
    if (this.config.databaseUrl) {
      try {
        this.pool = createPool(this.config.databaseUrl);
        await runMigrations(this.pool);
        this.optimizer = createOptimizer(this.pool, this.config.workspaceId, {
          enabled: this.config.optimizerEnabled,
        });
        console.log('✅ Database connected - metrics will be stored');
      } catch (err: any) {
        console.warn(`⚠️  Database connection failed: ${err.message}`);
        console.warn('   Proxy will run without metrics storage');
        this.pool = null;
        this.optimizer = null;
      }
    } else {
      console.log('ℹ️  No DATABASE_URL - running without metrics storage');
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Only handle POST requests to /v1/messages
    if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      // Read request body
      const body = await this.readBody(req);
      const request: APIRequest = JSON.parse(body);

      console.log('\n🔍 Intercepted API request');
      console.log(`   Original model: ${request.model || 'default'}`);

      let finalRequest = request;
      let optimizationMetrics = null;

      // Optimize if enabled
      if (this.optimizer) {
        const result = await this.optimizer.optimizeRequest(request);
        
        if (result.cacheHit && result.cachedResponse) {
          console.log('   ✅ Cache hit! Returning cached response');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.cachedResponse));
          return;
        }

        finalRequest = result.request;
        optimizationMetrics = result.metrics;

        console.log(`   Optimized model: ${finalRequest.model}`);
        console.log(`   Optimizations: ${result.metrics.optimizationsApplied.join(', ')}`);
        console.log(`   Estimated savings: $${result.metrics.costSaved.toFixed(4)}`);
      }

      // Forward to real Anthropic API
      const response = await this.forwardToAnthropic(finalRequest, req.headers);

      // Record metrics
      if (this.optimizer && optimizationMetrics) {
        await this.optimizer.recordResponse(finalRequest, response, optimizationMetrics);
      }

      // Return response to client
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));

    } catch (error: any) {
      console.error('❌ Proxy error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private async forwardToAnthropic(request: APIRequest, headers: any): Promise<APIResponse> {
    const url = `${this.config.anthropicBaseUrl}/v1/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': headers['anthropic-version'] || '2023-06-01',
        'x-api-key': this.config.anthropicApiKey,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    return await response.json();
  }

  async start() {
    await this.initialize();

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        console.error('Request handler error:', err);
        res.writeHead(500);
        res.end();
      });
    });

    server.listen(this.config.port, () => {
      console.log(`
╭─────────────────────────────────────────────────────────╮
│  Openeral Optimizer Proxy                               │
│  Status: ACTIVE                                         │
│  Port: ${this.config.port}                                           │
│  Optimizer: ${this.config.optimizerEnabled ? 'ENABLED' : 'DISABLED'}                                    │
│  Metrics: ${this.pool ? 'ENABLED' : 'DISABLED'}                                      │
│                                                         │
│  Set this in your environment:                          │
│  export ANTHROPIC_BASE_URL=http://localhost:${this.config.port}       │
│                                                         │
│  Then run: npx openeral                                 │
╰─────────────────────────────────────────────────────────╯
`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\nShutting down proxy...');
      server.close();
      if (this.pool) await this.pool.end();
      process.exit(0);
    });
  }
}

/**
 * Start the proxy server
 */
export async function startProxy(config: Partial<ProxyConfig> = {}) {
  const fullConfig: ProxyConfig = {
    port: config.port || 8000,
    anthropicApiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: config.anthropicBaseUrl || 'https://api.anthropic.com',
    databaseUrl: config.databaseUrl || process.env.DATABASE_URL || undefined,
    workspaceId: config.workspaceId || process.env.OPENERAL_WORKSPACE_ID || 'default',
    optimizerEnabled: config.optimizerEnabled ?? true,
  };

  if (!fullConfig.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required. Set it in your environment or pass it to startProxy()');
  }

  const proxy = new OptimizerProxy(fullConfig);
  await proxy.start();
}
