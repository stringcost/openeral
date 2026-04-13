# Openeral Optimizer

Active token and cost optimization for Claude Code running in Openeral.

## Features

### 1. Smart Model Routing (60-80% savings)
Automatically routes requests to the optimal model based on task complexity:
- **Haiku** (cheapest) - File operations, simple queries, bash commands
- **Sonnet** (balanced) - Code editing, moderate complexity
- **Opus** (expensive) - Complex reasoning, architecture decisions

### 2. Prompt Compression (10-20% savings)
- Removes excessive whitespace
- Truncates very long code blocks
- Deduplicates repeated content

### 3. Automatic Prompt Caching (50-90% on cached tokens)
- Enables Anthropic's prompt caching automatically
- Caches system prompts and large context blocks
- Reduces cost by 90% on repeated context

### 4. Local Response Caching (20-40% API call reduction)
- Caches identical requests in PostgreSQL
- Returns cached responses instantly
- Eliminates redundant API calls

## Usage

### CLI

```bash
# Enable optimizer (default)
npx openeral --optimize

# Disable optimizer
npx openeral --no-optimize

# View statistics
npx openeral optimize stats

# View stats for specific workspace
npx openeral optimize stats --workspace my-project --days 30
```

### Programmatic

```typescript
import { createOptimizer } from 'openeral-js';

const optimizer = createOptimizer(pool, 'my-workspace', {
  enabled: true,
  modelRouting: true,
  promptCompression: true,
  promptCaching: true,
  localCaching: true,
});

// Optimize request before sending to API
const { request: optimizedRequest, cacheHit, cachedResponse, metrics } = 
  await optimizer.optimizeRequest(originalRequest);

if (cacheHit) {
  // Use cached response
  return cachedResponse;
}

// Make API call with optimized request
const response = await anthropic.messages.create(optimizedRequest);

// Record response (stores metrics and caches)
await optimizer.recordResponse(optimizedRequest, response, metrics);
```

## Configuration

Environment variables:

```bash
# Enable/disable optimizer
OPENERAL_OPTIMIZER=on|off

# Prefer Haiku for all tasks (maximum savings)
OPENERAL_OPTIMIZER_PREFER_HAIKU=true

# Cache timeout (milliseconds)
OPENERAL_OPTIMIZER_CACHE_TIMEOUT=3600000
```

## Proof & Validation

The optimizer tracks every API call with before/after metrics:

```bash
$ npx openeral optimize stats

Openeral Optimizer - Last 7 Days
════════════════════════════════════════════════════════════

TOTAL SAVINGS
  Cost without optimizer:  $127.50
  Cost with optimizer:     $23.80
  Total saved:             $103.70 (81% reduction)
  
TOKEN USAGE
  Original tokens:         3,250,000
  Optimized tokens:        1,100,000
  Tokens saved:            2,150,000 (66% reduction)

MODEL DISTRIBUTION
  Haiku:   720 calls (72%)
  Sonnet:  250 calls (25%)
  Opus:    30 calls (3%)
  
OPTIMIZATION BREAKDOWN
  Smart routing:           $85.20 saved (82%)
  Prompt compression:      $12.30 saved (12%)
  Prompt caching:          $4.50 saved (4%)
  Local cache hits:        $1.70 saved (2%)

CACHE PERFORMANCE
  API calls made:          1,000
  Cache hits:              180 (18%)
```

## Database Schema

The optimizer stores metrics in PostgreSQL:

```sql
-- Optimization metrics (proof of savings)
CREATE TABLE _openeral.optimization_metrics (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  original_model TEXT NOT NULL,
  original_prompt_tokens INTEGER NOT NULL,
  original_estimated_cost DECIMAL(10, 6) NOT NULL,
  optimized_model TEXT NOT NULL,
  optimized_prompt_tokens INTEGER NOT NULL,
  optimized_actual_cost DECIMAL(10, 6) NOT NULL,
  optimizations_applied TEXT[] NOT NULL,
  task_type TEXT NOT NULL,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  tokens_saved INTEGER NOT NULL,
  cost_saved DECIMAL(10, 6) NOT NULL,
  savings_percentage DECIMAL(5, 2) NOT NULL,
  metadata JSONB
);

-- Local response cache
CREATE TABLE _openeral.api_cache (
  key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code (unchanged)                                     │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ API Request
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Openeral Optimizer Interceptor                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 1. Check Local Cache                                 │   │
│  │ 2. Analyze Task Complexity                           │   │
│  │ 3. Select Optimal Model (Haiku/Sonnet/Opus)         │   │
│  │ 4. Compress Prompt                                   │   │
│  │ 5. Enable Prompt Caching                             │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ Optimized Request
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Anthropic API                                               │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ Response
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Metrics Tracker                                             │
│  - Store metrics in PostgreSQL                               │
│  - Cache response for future requests                        │
└─────────────────────────────────────────────────────────────┘
```

## Expected Savings

### Conservative Estimate
- Model routing: 50% cost reduction
- Prompt compression: 10% token reduction
- Prompt caching: 20% additional savings
- Local caching: 10% API call reduction
- **Total: 60-70% cost reduction**

### Aggressive Estimate (Optimal Conditions)
- Model routing: 70% cost reduction
- Prompt compression: 20% token reduction
- Prompt caching: 50% additional savings
- Local caching: 30% API call reduction
- **Total: 80-85% cost reduction**

## Example

**Without Optimizer:**
```
Task: "List files in /db/public/users"
Model: claude-opus-4 (user's default)
Tokens: 500 input
Cost: $0.0075
```

**With Optimizer:**
```
Task: "List files in /db/public/users"
Detected: Simple file operation
Model: claude-3-5-haiku (auto-selected)
Tokens: 450 input (compressed)
Cost: $0.00036
Savings: 95%
```

## Limitations

- Model routing is conservative (defaults to Sonnet when unsure)
- Prompt compression never removes user messages
- Cache TTL is 1 hour by default
- Requires PostgreSQL for metrics and caching

## Future Enhancements

- ML-based model selection (learn from usage patterns)
- Context window optimization (send only relevant files)
- Batch request optimization
- Multi-provider support (OpenAI, etc.)
- Budget alerts and limits
