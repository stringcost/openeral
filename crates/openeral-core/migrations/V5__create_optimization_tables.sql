CREATE TABLE IF NOT EXISTS _openeral.optimization_metrics (
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

CREATE INDEX IF NOT EXISTS idx_optimization_metrics_workspace
    ON _openeral.optimization_metrics (workspace_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_optimization_metrics_model
    ON _openeral.optimization_metrics (optimized_model, timestamp DESC);

CREATE TABLE IF NOT EXISTS _openeral.api_cache (
    key TEXT PRIMARY KEY,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_cache_created
    ON _openeral.api_cache (created_at);
