/**
 * Example: Using the Openeral Optimizer
 * 
 * This demonstrates how to integrate the optimizer with your API calls
 */

import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrations.js';
import { createOptimizer } from './optimizer.js';
import type { APIRequest, APIResponse } from './types.js';

async function example() {
  // Setup
  const pool = createPool(process.env.DATABASE_URL!);
  await runMigrations(pool);
  
  const optimizer = createOptimizer(pool, 'my-workspace', {
    enabled: true,
    modelRouting: true,
    promptCompression: true,
    promptCaching: true,
    localCaching: true,
  });

  // Example API request (what Claude Code would send)
  const request: APIRequest = {
    model: 'claude-opus-4-20250514', // User's default (expensive!)
    messages: [
      {
        role: 'user',
        content: 'List files in the current directory',
      },
    ],
    max_tokens: 1024,
  };

  console.log('Original request:', {
    model: request.model,
    task: 'List files',
  });

  // Optimize the request
  const { request: optimizedRequest, cacheHit, cachedResponse, metrics } = 
    await optimizer.optimizeRequest(request);

  console.log('\nOptimized request:', {
    model: optimizedRequest.model,
    cacheHit,
    optimizationsApplied: metrics.optimizationsApplied,
  });

  console.log('\nSavings:', {
    originalCost: `$${metrics.originalEstimatedCost.toFixed(4)}`,
    optimizedCost: `$${metrics.optimizedActualCost.toFixed(4)}`,
    saved: `$${metrics.costSaved.toFixed(4)}`,
    percentage: `${metrics.savingsPercentage.toFixed(0)}%`,
  });

  // If cache hit, use cached response
  if (cacheHit && cachedResponse) {
    console.log('\nUsing cached response (no API call needed!)');
    return;
  }

  // Otherwise, make the API call with optimized request
  // const response = await anthropic.messages.create(optimizedRequest);
  
  // Simulate response for demo
  const response: APIResponse = {
    id: 'msg_123',
    model: optimizedRequest.model,
    content: [{ type: 'text', text: 'file1.txt\nfile2.txt\nfile3.txt' }],
    usage: {
      input_tokens: 150,
      output_tokens: 20,
    },
  };

  // Record the response (stores metrics and caches response)
  await optimizer.recordResponse(optimizedRequest, response, metrics);

  console.log('\nResponse recorded. Next identical request will be cached!');

  await pool.end();
}

// Run example
if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}
