/**
 * Anthropic Usage & Cost API client
 * Fetches usage data that StringCost also uses
 */

export interface AnthropicUsageRecord {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  workspace_id?: string;
  metadata?: Record<string, any>;
}

export interface AnthropicUsageResponse {
  data: AnthropicUsageRecord[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

/**
 * Fetch usage data from Anthropic API
 */
export async function fetchAnthropicUsage(
  apiKey: string,
  options: {
    startDate?: string; // YYYY-MM-DD
    endDate?: string;   // YYYY-MM-DD
    limit?: number;
  } = {}
): Promise<AnthropicUsageRecord[]> {
  const { startDate, endDate, limit = 1000 } = options;

  const url = new URL('https://api.anthropic.com/v1/organizations/usage');
  if (startDate) url.searchParams.set('start_date', startDate);
  if (endDate) url.searchParams.set('end_date', endDate);
  url.searchParams.set('limit', limit.toString());

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data: AnthropicUsageResponse = await response.json();
    return data.data || [];
  } catch (err: any) {
    throw new Error(`Failed to fetch usage data: ${err.message}`);
  }
}

/**
 * Fetch usage for last N days
 */
export async function fetchRecentUsage(
  apiKey: string,
  daysBack: number = 7
): Promise<AnthropicUsageRecord[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  return fetchAnthropicUsage(apiKey, {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
  });
}

/**
 * Store usage records in database
 */
export async function storeUsageRecords(
  pool: any,
  workspaceId: string,
  records: AnthropicUsageRecord[]
): Promise<number> {
  let stored = 0;

  for (const record of records) {
    try {
      await pool.query(
        `INSERT INTO _openeral.optimization_metrics (
          workspace_id, timestamp, original_model, original_prompt_tokens,
          original_estimated_cost, optimized_model, optimized_prompt_tokens,
          optimized_actual_cost, optimizations_applied, task_type, cache_hit,
          tokens_saved, cost_saved, savings_percentage, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT DO NOTHING`,
        [
          workspaceId,
          new Date(record.timestamp),
          record.model,
          record.input_tokens,
          record.cost_usd,
          record.model, // Same model (no optimization yet)
          record.input_tokens,
          record.cost_usd,
          [], // No optimizations applied
          'unknown',
          false,
          0,
          0,
          0,
          JSON.stringify(record.metadata || {}),
        ]
      );
      stored++;
    } catch (err: any) {
      // Ignore duplicates
      if (!err.message.includes('duplicate')) {
        console.warn(`Failed to store record: ${err.message}`);
      }
    }
  }

  return stored;
}

/**
 * Sync usage data from Anthropic API to local database
 */
export async function syncUsageData(
  pool: any,
  workspaceId: string,
  apiKey: string,
  daysBack: number = 7
): Promise<{ fetched: number; stored: number }> {
  console.log(`📥 Fetching usage data from Anthropic API (last ${daysBack} days)...`);
  
  const records = await fetchRecentUsage(apiKey, daysBack);
  console.log(`   Found ${records.length} records`);

  if (records.length === 0) {
    return { fetched: 0, stored: 0 };
  }

  console.log('💾 Storing in local database...');
  const stored = await storeUsageRecords(pool, workspaceId, records);
  console.log(`   Stored ${stored} new records`);

  return { fetched: records.length, stored };
}
