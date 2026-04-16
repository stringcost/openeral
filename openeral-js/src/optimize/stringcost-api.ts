/**
 * StringCost API client
 *
 * How token counting works with StringCost:
 *   1. npx openeral calls POST https://app.stringcost.com/v1/presign → gets a proxy URL
 *      e.g. https://proxy.stringcost.com/stringcost-proxy/t/{JWT}/v1/messages
 *   2. ANTHROPIC_BASE_URL is set to that proxy URL (without /v1/messages)
 *   3. Every Claude API response through that URL includes:
 *        "usage": { "input_tokens": N, "output_tokens": N, ... }
 *   4. StringCost logs these events server-side under the session (sid) embedded in the JWT
 *
 * To retrieve the data later, we decode the JWT to get the session ID (sid)
 * and then query the StringCost management API at https://app.stringcost.com/v1/...
 */

export interface StringCostUsageEvent {
  id: string;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: number;
}

/**
 * Decode the JWT from a StringCost presign URL to extract session metadata.
 *
 * The presign URL format is:
 *   https://proxy.stringcost.com/stringcost-proxy/t/{JWT}/v1/messages
 *
 * The JWT is a base64url-encoded JSON with two fields:
 *   { "p": "<inner-base64url-JWT>", "s": "<signature>" }
 *
 * The inner JWT "p" contains:
 *   { "sid": "<session-id>", "cid": "<client-id>", "provider": "anthropic", ... }
 */
export function decodePresignUrl(presignUrl: string): {
  sessionId?: string;
  clientId?: string;
  rawToken?: string;
} {
  const match = presignUrl.match(/\/stringcost-proxy\/t\/([^/]+)\//);
  if (!match) return {};

  const rawToken = match[1];

  try {
    // Outer envelope: { p: "...", s: "..." }
    const outer = JSON.parse(Buffer.from(rawToken, 'base64url').toString('utf8'));
    if (!outer.p) return { rawToken };

    // Inner payload
    const inner = JSON.parse(Buffer.from(outer.p, 'base64url').toString('utf8'));

    return {
      sessionId: inner.sid ?? undefined,
      clientId: inner.cid ?? undefined,
      rawToken,
    };
  } catch {
    return { rawToken };
  }
}

/**
 * Fetch usage events from the StringCost management API.
 *
 * The management API lives at https://app.stringcost.com/v1/ — the same host
 * as the presign endpoint.  We try several plausible paths in order and return
 * whichever one responds with 200.
 *
 * Supported query parameters across all tried endpoints:
 *   limit, from (ISO timestamp), session_id / sink_id
 */
export async function fetchStringCostEvents(
  apiKey: string,
  options: {
    sessionId?: string;
    clientId?: string;
    from?: Date;
    limit?: number;
  } = {},
): Promise<StringCostUsageEvent[]> {
  const { sessionId, from, limit = 1000 } = options;

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (from) params.set('from', from.toISOString());
  if (sessionId) {
    params.set('session_id', sessionId);
    params.set('sink_id', sessionId);
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Try session-scoped endpoints first (more targeted), then account-wide ones.
  // All use /v1/ (no /api/ prefix — consistent with /v1/presign).
  const candidates: string[] = [];

  if (sessionId) {
    candidates.push(
      `https://app.stringcost.com/v1/sinks/${sessionId}/events`,
      `https://app.stringcost.com/v1/sinks/${sessionId}`,
      `https://app.stringcost.com/v1/sessions/${sessionId}/events`,
      `https://app.stringcost.com/v1/sessions/${sessionId}`,
    );
  }

  candidates.push(
    `https://app.stringcost.com/v1/events?${params}`,
    `https://app.stringcost.com/v1/logs?${params}`,
    `https://app.stringcost.com/v1/sessions?${params}`,
    `https://app.stringcost.com/v1/usage?${params}`,
  );

  let lastError = 'no endpoints tried';

  for (const endpoint of candidates) {
    try {
      const url = endpoint.includes('?') ? endpoint : `${endpoint}?${params}`;
      const response = await fetch(url, { headers });

      if (response.ok) {
        const data = await response.json();
        const events = normalizeEvents(data);
        if (events.length > 0 || response.status === 200) {
          return events;
        }
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'StringCost authentication failed. ' +
          'Check that STRINGCOST_API_KEY is correct.',
        );
      }

      // 404 means this endpoint doesn't exist — try the next one
      if (response.status === 404) {
        lastError = `404 at ${new URL(endpoint).pathname}`;
        continue;
      }

      lastError = `HTTP ${response.status} at ${new URL(endpoint).pathname}`;
    } catch (err: any) {
      if (err.message.includes('authentication failed')) throw err;
      lastError = err.message;
    }
  }

  throw new Error(
    `Could not retrieve usage data from StringCost API.\n` +
    `Last error: ${lastError}\n\n` +
    `Possible reasons:\n` +
    `  - StringCost may not yet expose a public management API for event queries\n` +
    `  - Your API key may not have read access to event data\n\n` +
    `You can still view your usage at: https://app.stringcost.com`,
  );
}

/**
 * Normalise different JSON shapes that the StringCost API might return.
 *
 * The proxy response looks like a standard Anthropic response body, so when
 * stringcost stores events it likely keeps the same shape:
 *   { usage: { input_tokens, output_tokens, ... }, model, id, ... }
 */
function normalizeEvents(data: unknown): StringCostUsageEvent[] {
  if (Array.isArray(data)) {
    return data.flatMap((item) => normalizeEvent(item) ?? []);
  }

  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;

    // { events: [...] }
    if (Array.isArray(d.events)) {
      return d.events.flatMap((item) => normalizeEvent(item) ?? []);
    }
    // { logs: [...] }
    if (Array.isArray(d.logs)) {
      return d.logs.flatMap((item) => normalizeEvent(item) ?? []);
    }
    // { sessions: [{ events: [...] }, ...] }
    if (Array.isArray(d.sessions)) {
      return (d.sessions as any[]).flatMap((s) =>
        Array.isArray(s.events) ? s.events.flatMap((e: unknown) => normalizeEvent(e) ?? []) : [],
      );
    }
    // { data: [...] }
    if (Array.isArray(d.data)) {
      return (d.data as any[]).flatMap((item) => normalizeEvent(item) ?? []);
    }

    // Single event object
    const single = normalizeEvent(d);
    if (single) return [single];
  }

  return [];
}

function normalizeEvent(item: unknown): StringCostUsageEvent | null {
  if (!item || typeof item !== 'object') return null;

  const raw = item as Record<string, any>;

  // The item might be a stored proxy response (has top-level usage + model)
  // or a wrapped event with a nested response object.
  const inner = raw.response ?? raw;
  const usage = inner.usage ?? raw.usage ?? inner;

  const inputTokens = Number(usage.input_tokens ?? raw.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? raw.output_tokens ?? 0);

  if (inputTokens === 0 && outputTokens === 0) return null;

  return {
    id: String(raw.id ?? raw.request_id ?? inner.id ?? `${Date.now()}-${Math.random()}`),
    timestamp: String(raw.timestamp ?? raw.created_at ?? raw.logged_at ?? new Date().toISOString()),
    model: String(inner.model ?? raw.model ?? 'unknown'),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: Number(
      usage.cache_creation_input_tokens ?? 0,
    ),
    cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0),
    cost: raw.cost ? Number(raw.cost) : undefined,
  };
}

/**
 * Store StringCost events in the local optimization_metrics table.
 */
export async function storeStringCostEvents(
  pool: any,
  workspaceId: string,
  events: StringCostUsageEvent[],
): Promise<number> {
  const { calculateCost } = await import('./metrics.js');
  let stored = 0;

  for (const event of events) {
    const inputTokens = event.input_tokens;
    const outputTokens = event.output_tokens;
    const cacheReadTokens = event.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = event.cache_creation_input_tokens ?? 0;
    const cacheHit = cacheReadTokens > 0;
    const cost = event.cost ?? calculateCost(event.model, inputTokens, outputTokens);

    try {
      await pool.query(
        `INSERT INTO _openeral.optimization_metrics (
          workspace_id, timestamp, original_model, original_prompt_tokens,
          original_estimated_cost, optimized_model, optimized_prompt_tokens,
          optimized_actual_cost, optimizations_applied, task_type, cache_hit,
          tokens_saved, cost_saved, savings_percentage, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          workspaceId,
          new Date(event.timestamp),
          event.model,
          inputTokens,
          cost,
          event.model,
          inputTokens,
          cost,
          [],
          'unknown',
          cacheHit,
          0,   // tokens_saved — no optimisation baseline when syncing from StringCost
          0,   // cost_saved
          0,   // savings_percentage
          JSON.stringify({
            output_tokens: outputTokens,
            cache_read_tokens: cacheReadTokens,
            cache_creation_tokens: cacheCreationTokens,
            event_id: event.id,
            source: 'stringcost',
          }),
        ],
      );
      stored++;
    } catch (err: any) {
      if (!err.message.includes('duplicate') && !err.message.includes('unique')) {
        console.warn(`Failed to store event ${event.id}: ${err.message}`);
      }
    }
  }

  return stored;
}

/**
 * Top-level sync: pull events from StringCost and persist them locally.
 *
 * Pass `sessionId` (from decodePresignUrl) to narrow the query to the
 * current workspace's session.  Without it, all events for the API key
 * are fetched.
 */
export async function syncStringCostData(
  pool: any,
  workspaceId: string,
  apiKey: string,
  options: {
    sessionId?: string;
    clientId?: string;
    daysBack?: number;
  } = {},
): Promise<{ fetched: number; stored: number }> {
  const { daysBack = 7, sessionId, clientId } = options;

  const from = new Date();
  from.setDate(from.getDate() - daysBack);

  if (sessionId) {
    console.log(`   Session ID: ${sessionId.slice(0, 8)}...`);
  }

  const events = await fetchStringCostEvents(apiKey, {
    sessionId,
    clientId,
    from,
    limit: 1000,
  });

  console.log(`   Found ${events.length} events`);

  if (events.length === 0) {
    return { fetched: 0, stored: 0 };
  }

  const stored = await storeStringCostEvents(pool, workspaceId, events);
  console.log(`   Stored ${stored} new records`);

  return { fetched: events.length, stored };
}
