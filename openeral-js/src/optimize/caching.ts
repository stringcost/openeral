/**
 * Prompt caching and local response caching
 */

import type { APIRequest, APIResponse, SystemMessage } from './types.js';
import type { DbPool } from '../db/pool.js';
import { createHash } from 'crypto';

/**
 * Enable Anthropic prompt caching on a request
 */
export function enablePromptCaching(request: APIRequest): APIRequest {
  const cached = { ...request };

  // Mark system prompt as cacheable
  if (typeof cached.system === 'string') {
    cached.system = [{
      type: 'text' as const,
      text: cached.system,
      cache_control: { type: 'ephemeral' as const },
    }];
  } else if (Array.isArray(cached.system) && cached.system.length > 0) {
    // Mark last system message as cacheable
    const lastIdx = cached.system.length - 1;
    cached.system[lastIdx] = {
      ...cached.system[lastIdx],
      cache_control: { type: 'ephemeral' as const },
    };
  }

  // Mark large context blocks in messages as cacheable
  if (cached.messages.length > 2) {
    // Cache the second-to-last message if it's large
    const contextIdx = cached.messages.length - 2;
    const contextMsg = cached.messages[contextIdx];
    
    if (contextMsg && typeof contextMsg.content === 'string' && contextMsg.content.length > 1024) {
      cached.messages[contextIdx] = {
        ...contextMsg,
        content: [{
          type: 'text' as const,
          text: contextMsg.content,
          cache_control: { type: 'ephemeral' as const },
        }],
      };
    }
  }

  return cached;
}

/**
 * Generate cache key for a request
 */
export function generateCacheKey(request: APIRequest): string {
  // Hash the last 3 messages + system prompt + model
  const cacheData = {
    model: request.model,
    system: request.system,
    messages: request.messages.slice(-3),
  };
  
  const hash = createHash('sha256');
  hash.update(JSON.stringify(cacheData));
  return hash.digest('hex');
}

/**
 * Get cached response from local database
 */
export async function getCachedResponse(
  pool: DbPool,
  cacheKey: string,
  timeoutMs: number
): Promise<APIResponse | null> {
  const result = await pool.query(
    `SELECT response, created_at 
     FROM _openeral.api_cache 
     WHERE key = $1 
     AND created_at > NOW() - INTERVAL '1 millisecond' * $2
     LIMIT 1`,
    [cacheKey, timeoutMs]
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Handle both string (from some drivers) and object (JSONB native) responses
  const raw = result.rows[0].response;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as APIResponse);
}

/**
 * Store response in local cache
 */
export async function setCachedResponse(
  pool: DbPool,
  cacheKey: string,
  response: APIResponse
): Promise<void> {
  await pool.query(
    `INSERT INTO _openeral.api_cache (key, response, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET response = $2, created_at = NOW()`,
    [cacheKey, JSON.stringify(response)]
  );
}

/**
 * Clear old cache entries
 */
export async function clearOldCache(pool: DbPool, olderThanMs: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM _openeral.api_cache 
     WHERE created_at < NOW() - INTERVAL '1 millisecond' * $1`,
    [olderThanMs]
  );
  
  return result.rowCount || 0;
}
