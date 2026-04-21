# Gap Plan: Query-driven semantic memory refresh

## Goal

Let users run `openeral memory refresh --query "..."` and have OpenEral regenerate Claude Code's memory files (`~/.claude/projects/<slug>/memory/MEMORY.md` + topic files) with semantically relevant content pulled from PostgreSQL, using pgvector embeddings.

Default behaviour (`openeral memory refresh` with no query) must match what Claude Code itself expects — the existing 5 topic templates already do this.

---

## Where we stand today

### Already built

| Area | Status | File |
|---|---|---|
| Data model (types) | ✅ | `openeral-js/src/memory/types.ts` |
| Filesystem walker + chunker | ✅ | `openeral-js/src/memory/collect.ts` |
| Lexical ranker (token/freshness/kind) | ✅ | `openeral-js/src/memory/rank.ts` |
| Markdown renderer (MEMORY.md + topic files) | ✅ | `openeral-js/src/memory/render.ts` |
| Project-slug / memory-dir resolver | ✅ | `openeral-js/src/memory/resolve.ts` |
| Orchestrator (default + focus modes) | ✅ | `openeral-js/src/memory/refresh.ts` |
| CLI argument parsing | ✅ | `openeral-js/src/cli.ts:150-183` |
| Existing DB schema (workspace_files etc.) | ✅ | `openeral-js/src/db/migrations.ts` (V1–V5) |

### Not yet built (the gaps)

| # | Gap | Consequence |
|---|---|---|
| 1 | CLI handler is a stub | `openeral memory refresh` exits with "not yet implemented" at `src/cli.ts:1999-2001` |
| 2 | No pgvector, no embeddings column | `--query` can only rank lexically; "how does auth work" misses files that say "login flow" |
| 3 | No embedding provider client | Cannot call OpenAI/Voyage — even if schema existed, we have no way to populate it |
| 4 | No session-log indexing | Claude's own `~/.claude/projects/<slug>/*.jsonl` transcripts are never searched |
| 5 | No continuous embedding in sync | Files sync to Postgres but never get embedded; every refresh would have to re-embed from scratch |
| 6 | No `memory stats` / `memory reindex` commands | Users can't see embedding coverage or re-embed after switching providers |

---

## User-selected design choices

- **Embedding provider**: pluggable — detect `VOYAGE_API_KEY` first, `OPENAI_API_KEY` second, fall back to lexical if neither.
- **Corpus**: filesystem files **plus** Claude session logs (`~/.claude/projects/<slug>/*.jsonl`).
- **Timing**: continuous — embed on every sync, hash-cache to skip unchanged chunks.
- **Default mode**: keep the existing 5 topic templates; only `--query` uses semantic search.

---

## Gap-by-gap plan

### Gap 1: Wire the CLI handler

**File**: `openeral-js/src/cli.ts` (replace lines ~1999–2001)

Replace:
```ts
if (parsed.kind === 'memory-refresh') {
  process.stderr.write('\x1b[31mopeneral: memory refresh not yet implemented\x1b[0m\n');
  process.exit(1);
}
```

With a call to `refreshClaudeMemory()` that:
- Opens the pool only if `DATABASE_URL` is set (otherwise fallback-only mode).
- Calls `detectEmbeddingProvider()` from the new `embed.ts`.
- Passes pool, provider, workspaceId through to the orchestrator.
- Prints the result summary (mode, written files, provider used).

### Gap 2: pgvector schema (V6 migration)

**File**: `openeral-js/src/db/migrations.ts` — add V6 inside the existing advisory-lock block.

```sql
-- Skip gracefully if extension is not installed; report degraded state.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS _openeral.memory_chunks (
  workspace_id   TEXT NOT NULL
                 REFERENCES _openeral.workspace_config(id) ON DELETE CASCADE,
  chunk_id       TEXT NOT NULL,          -- <source>:<path>:<ordinal>
  source_kind    TEXT NOT NULL,          -- 'file' | 'session'
  source_path    TEXT NOT NULL,
  title          TEXT,
  excerpt        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,          -- sha256 — idempotency key
  embedding      vector,                  -- NULL when no provider configured
  embed_model    TEXT,                   -- 'voyage-3-lite' | 'text-embedding-3-small'
  embed_dims     INTEGER,                -- 512 or 1536 depending on provider
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_ws
  ON _openeral.memory_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_hash
  ON _openeral.memory_chunks (workspace_id, content_hash);

-- IVFFlat cosine index (only if pgvector is actually available)
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
  ON _openeral.memory_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

Notes:
- `vector` without `(N)` allows any dim, so Voyage (512) and OpenAI (1536) can coexist. Query filters by `embed_dims = $K`.
- If the `vector` extension isn't installed, the migration catches the error, logs a warning, and continues. `runMigrations()` returns a `{ vectorAvailable: boolean }` flag that callers can use to decide whether to offer semantic search.

### Gap 3: Embedding provider client

**New file**: `openeral-js/src/memory/embed.ts`

```ts
export type Provider = 'voyage' | 'openai' | null;

export function detectProvider(): Provider { /* env-based */ }

export interface EmbeddingResult {
  model: string;
  dims: number;
  vectors: number[][];
}

export async function embed(
  provider: Provider,
  texts: string[],          // batched, up to 100 per call
): Promise<EmbeddingResult>;
```

- Voyage: `voyage-3-lite`, 512 dims, via `https://api.voyageai.com/v1/embeddings`.
- OpenAI: `text-embedding-3-small`, 1536 dims, via `https://api.openai.com/v1/embeddings`.
- Both support batching; client batches up to 100 and retries on 429 with backoff.
- **Never** hardcode keys; read from env each call.

### Gap 4: Session-log corpus

**New file**: `openeral-js/src/memory/session-logs.ts`

```ts
export async function collectSessionLogs(
  projectSlug: string,
  opts?: { maxBytesPerFile?: number; since?: Date },
): Promise<MemorySourceFile[]>;
```

- Reads `~/.claude/projects/<slug>/*.jsonl`.
- Each line is a JSON event; extract `role: 'user' | 'assistant'` plus `content` text.
- Groups consecutive turns into a single chunk up to ~8 KB.
- Tags result with `source: 'session'` so the ranker can apply a different kind-boost.

### Gap 5: Continuous embedding pipeline

**New file**: `openeral-js/src/memory/sync-embeddings.ts`

```ts
export async function embedChunks(
  pool: pg.Pool,
  workspaceId: string,
  chunks: MemoryChunk[],
  provider: Provider,
): Promise<{ embedded: number; skipped: number }>;
```

- For each chunk: compute `sha256(excerpt)`.
- `SELECT content_hash FROM memory_chunks WHERE workspace_id = $1 AND chunk_id = $2` — skip if hash matches.
- Batch new/changed chunks by 100, call `embed()`, `UPSERT` into `memory_chunks`.

**Hook site**: `openeral-js/src/sync.ts` — after `syncFromFs` finishes its walk, call `embedChunks()` for changed files. Guard behind `provider !== null`; never block the sync on embedding errors.

### Gap 6: Vector ranking

**New file**: `openeral-js/src/memory/vector-rank.ts`

```ts
export async function rankByVector(
  pool: pg.Pool,
  workspaceId: string,
  queryVector: number[],
  queryDims: number,
  opts: { limit: number; lexicalScores?: Map<string, number> },
): Promise<RankedMemoryChunk[]>;
```

SQL:
```sql
SELECT chunk_id, source_kind, source_path, title, excerpt,
       1 - (embedding <=> $1::vector) AS cosine
FROM _openeral.memory_chunks
WHERE workspace_id = $2 AND embed_dims = $3
ORDER BY embedding <=> $1::vector
LIMIT $4;
```

Final score = `0.7 * cosine + 0.3 * lexicalScore` (weights tunable), reasons array explains both contributions. Preserves existing dirty-path and freshness boosts from `rank.ts`.

### Gap 7: CLI additions

**File**: `openeral-js/src/cli.ts`

Parse two new subcommands:

```
openeral memory stats      # chunk count, embed coverage %, provider in use, dims
openeral memory reindex    # drop embedding, re-embed every chunk (e.g. after switching provider)
```

Both reuse the existing pool/workspace resolution.

---

## Files at a glance

### New

- `openeral-js/src/memory/embed.ts`
- `openeral-js/src/memory/vector-rank.ts`
- `openeral-js/src/memory/session-logs.ts`
- `openeral-js/src/memory/sync-embeddings.ts`
- `openeral-js/src/db/memory-queries.ts`
- `openeral-js/src/memory/embed.test.ts`
- `openeral-js/src/memory/vector-rank.test.ts`
- `openeral-js/src/memory/session-logs.test.ts`

### Modified

- `openeral-js/src/cli.ts` (wire handler, add `stats` and `reindex` subcommands)
- `openeral-js/src/memory/refresh.ts` (route query mode through vector-rank when available)
- `openeral-js/src/memory/rank.ts` (return named lexical score map for blending)
- `openeral-js/src/memory/types.ts` (add `source`, `contentHash`, optional `embedding`)
- `openeral-js/src/sync.ts` (trigger embedChunks after walks)
- `openeral-js/src/db/migrations.ts` (V6 inside advisory-lock block)
- `.claude/skills/openeral-shell/SKILL.md` (document new subcommands)
- `README.md` (document `--query`, env vars, pgvector requirement)
- `openeral-js/lint.mjs` (new lints — see below)

---

## Lints and tests

### Lints (add to `openeral-js/lint.mjs`)

| # | Rule |
|---|---|
| new | No hardcoded `VOYAGE_API_KEY` / `OPENAI_API_KEY` / `sk-` strings in sources |
| new | `embed.ts` must read keys from `process.env`, not from a config file |
| new | V6 migration must use `CREATE EXTENSION IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` |
| new | `sync-embeddings.ts` must check `content_hash` before calling `embed()` |
| new | `vector-rank.ts` must filter by `embed_dims` in its WHERE clause |

### Unit tests

- `embed.test.ts` — provider detection logic, batch size enforcement, no network calls (stub `fetch`).
- `vector-rank.test.ts` — blending weights, dim filtering, empty-result handling.
- `session-logs.test.ts` — jsonl parsing, turn grouping, size limits, unicode.
- `migrations.test.ts` — V6 runs when pgvector is installed; V6 degrades gracefully when not.

### Integration (live Postgres with pgvector)

Fixture: insert 10 chunks with known vectors (mocked provider that maps strings → deterministic vectors). Query, verify the top result is the one whose mocked vector matches the query's mocked vector.

### E2E (extends `tests/test_claude_e2e.sh`)

Add a session 3 that runs `openeral memory refresh --query "<content from session 1 file>"`, then checks that the resulting `focus-*.md` mentions the file path written in session 1.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| pgvector not installed on user's Postgres | V6 migration catches error, lexical ranking still works. `memory stats` reports "vector: unavailable". |
| Embedding API costs | Content-hash cache means the same content never gets re-embedded. Provider is opt-in (no env var = no API cost). |
| Dim mismatch when user switches provider | `embed_dims` column + `WHERE embed_dims = $K` in queries. `memory reindex` re-embeds everything at the new dim. |
| Session logs contain sensitive content | Never send session logs to embedding APIs unless a provider is explicitly configured by the user. Document this. |
| Big sessions slow down `syncFromFs` | Embedding runs at end of walk, not per-file. Timeouts with fallback. Batched, async. |
| Sync cycle blocks on API timeouts | Wrap each batch in a timeout; on error, mark chunks as "pending" and retry at next sync. |

---

## Verification

```bash
export DATABASE_URL='postgresql://…'
export VOYAGE_API_KEY='…'   # or OPENAI_API_KEY

cd openeral-js
pnpm install && pnpm build
pnpm check                                    # new lints + new unit tests

# 1. Fresh DB: V6 runs, reports pgvector status
DATABASE_URL=… node dist/bin/openeral.js memory stats

# 2. Sync a workspace, observe embeddings populated
#    (triggered automatically via watchAndSync)

# 3. Query-driven refresh
DATABASE_URL=… VOYAGE_API_KEY=… \
  node dist/bin/openeral.js memory refresh --query "socket credential injection"

# 4. Fallback: without a provider, --query still works via lexical
unset VOYAGE_API_KEY OPENAI_API_KEY
DATABASE_URL=… node dist/bin/openeral.js memory refresh --query "socket credential injection"

# 5. E2E
bash tests/test_claude_e2e.sh
```

Expected:
- With provider: `focus-socket-credential-injection.md` contains chunks from the Socket.dev policy + setup.sh + session logs that discuss credential injection.
- Without provider: same file, but ranked lexically (still functional, no semantic boost).
- `memory stats` shows coverage % (chunks with embedding / total chunks) and provider+model in use.
- E2E assertion: file written in session 1 is surfaced when session 3 asks about it via `--query`.
