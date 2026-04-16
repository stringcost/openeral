/**
 * Lightweight local proxy that optimizes requests before sending to StringCost
 * Runs automatically when npx openeral starts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { analyzeTask, selectOptimalModel } from './task-analyzer.js';
import { compressPrompt, estimateRequestTokens } from './prompt-compressor.js';
import type { APIRequest } from './types.js';

const LOCAL_PROXY_PORT = 54321; // Local optimization proxy
let proxyServer: ReturnType<typeof createServer> | null = null;

export interface ProxyOptions {
  targetUrl: string; // StringCost URL or Anthropic URL
  optimizationEnabled: boolean;
}

/**
 * Start local optimization proxy
 */
export async function startLocalProxy(options: ProxyOptions): Promise<number> {
  if (proxyServer) {
    return LOCAL_PROXY_PORT; // Already running
  }

  return new Promise((resolve, reject) => {
    proxyServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await handleProxyRequest(req, res, options);
      } catch (err: any) {
        console.error('Proxy error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    proxyServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Port already in use, assume proxy is already running
        resolve(LOCAL_PROXY_PORT);
      } else {
        reject(err);
      }
    });

    proxyServer.listen(LOCAL_PROXY_PORT, () => {
      resolve(LOCAL_PROXY_PORT);
    });
  });
}

/**
 * Handle proxy request
 */
async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions
): Promise<void> {
  // Only handle POST requests to /v1/messages
  if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Read request body
  const body = await readBody(req);
  let request: APIRequest = JSON.parse(body);

  // Optimize if enabled
  if (options.optimizationEnabled) {
    const originalModel = request.model || 'claude-3-5-sonnet-20241022';
    const originalTokens = estimateRequestTokens(request);

    // 1. Analyze task and select optimal model
    const task = analyzeTask(request);
    const optimalModel = selectOptimalModel(task, false);
    
    if (optimalModel !== originalModel) {
      request.model = optimalModel;
    }

    // 2. Compress prompt
    request = compressPrompt(request);

    const optimizedTokens = estimateRequestTokens(request);
    const tokensSaved = originalTokens - optimizedTokens;

    // Log optimization (silent, just for debugging)
    if (process.env.OPENERAL_DEBUG) {
      console.log(`[Optimizer] ${originalModel} → ${optimalModel}, saved ${tokensSaved} tokens`);
    }
  }

  // Forward to target (StringCost or Anthropic)
  const targetUrl = `${options.targetUrl}${req.url}`;
  
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] as string || '2023-06-01',
      'x-api-key': req.headers['x-api-key'] as string,
    },
    body: JSON.stringify(request),
  });

  // Forward response back to client
  const responseBody = await response.text();
  res.writeHead(response.status, {
    'Content-Type': 'application/json',
  });
  res.end(responseBody);
}

/**
 * Read request body
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Stop local proxy
 */
export function stopLocalProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}

/**
 * Get local proxy URL
 */
export function getLocalProxyUrl(): string {
  return `http://localhost:${LOCAL_PROXY_PORT}`;
}
