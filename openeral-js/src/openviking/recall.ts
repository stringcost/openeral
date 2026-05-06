import type { OpenVikingClient } from './client.js';
import type { Memory, OpenVikingConfig } from './types.js';
import type { MemoryChunk, RankedMemoryChunk } from '../memory/types.js';

// OpenViking similarity scores are 0-1. Multiply by this to put them on the
// same scale as the local keyword scorer (typical top scores: 20-35).
const OV_SCORE_SCALE = 30;

export interface HybridRecallOptions {
  limit?: number;
  scoreThreshold?: number;
  localWeight?: number;
  remoteWeight?: number;
}

export async function recallWithOpenViking(
  client: OpenVikingClient,
  config: OpenVikingConfig,
  query: string,
): Promise<RankedMemoryChunk[]> {
  const { limit, scoreThreshold } = config.autoRecall;

  const [userMemories, agentMemories] = await Promise.allSettled([
    client.search(query, { uri: 'viking://user/memories/', limit: limit * 2 }),
    client.search(query, { uri: 'viking://agent/memories/', limit: limit * 2 }),
  ]);

  const all: Memory[] = [
    ...(userMemories.status === 'fulfilled' ? userMemories.value : []),
    ...(agentMemories.status === 'fulfilled' ? agentMemories.value : []),
  ];

  const seen = new Set<string>();
  const unique = all.filter((m) => {
    if (seen.has(m.uri)) return false;
    seen.add(m.uri);
    return true;
  });

  return unique
    .map((m) => vikingMemoryToChunk(m, query))
    .filter((c) => c.score >= scoreThreshold * OV_SCORE_SCALE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function hybridRecall(
  localChunks: MemoryChunk[],
  localRanked: RankedMemoryChunk[],
  client: OpenVikingClient,
  config: OpenVikingConfig,
  query: string,
  opts: HybridRecallOptions = {},
): Promise<RankedMemoryChunk[]> {
  const localWeight = opts.localWeight ?? 0.4;
  const remoteWeight = opts.remoteWeight ?? 0.6;
  const limit = opts.limit ?? config.autoRecall.limit;

  let ovChunks: RankedMemoryChunk[] = [];
  try {
    ovChunks = await recallWithOpenViking(client, config, query);
  } catch {
    // OpenViking unavailable — fall back to local only
  }

  if (ovChunks.length === 0) return localRanked.slice(0, limit);

  // Scale both sets to [0,1] range, then apply weights
  const localMax = localRanked[0]?.score ?? 1;
  const ovMax = ovChunks[0]?.score ?? 1;

  const localScaled = localRanked.map((c) => ({
    ...c,
    score: (c.score / localMax) * localWeight * OV_SCORE_SCALE,
    reasons: [...c.reasons, 'local-keyword'],
  }));

  const ovScaled = ovChunks.map((c) => ({
    ...c,
    score: (c.score / ovMax) * remoteWeight * OV_SCORE_SCALE,
    reasons: [...c.reasons, 'openviking-semantic'],
  }));

  // Merge: if same chunkId exists in both, keep the higher-scoring entry
  const merged = new Map<string, RankedMemoryChunk>();
  for (const c of [...localScaled, ...ovScaled]) {
    const existing = merged.get(c.chunkId);
    if (!existing || c.score > existing.score) merged.set(c.chunkId, c);
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function vikingMemoryToChunk(memory: Memory, _query: string): RankedMemoryChunk {
  const lines = memory.content.split('\n').filter((l) => l.trim());
  const title = lines[0]?.slice(0, 80) ?? memory.uri;
  const excerpt = memory.content.slice(0, 500);
  const tokens = new Set(
    memory.content.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g) ?? [],
  );

  let score = memory.score * OV_SCORE_SCALE;
  if (memory.level === 2) score += 0.15 * OV_SCORE_SCALE; // leaf boost
  if (memory.created_at) {
    const ageDays = (Date.now() - new Date(memory.created_at).getTime()) / 86_400_000;
    if (ageDays < 7) score += 0.1 * OV_SCORE_SCALE; // temporal boost
  }

  const syntheticPath = `viking://${memory.uri.replace(/^viking:\/\//, '')}`;

  return {
    absPath: syntheticPath,
    relPath: syntheticPath,
    kind: 'memory',
    content: memory.content,
    mtimeMs: memory.created_at ? new Date(memory.created_at).getTime() : Date.now(),
    chunkId: memory.uri,
    title,
    excerpt,
    tokenSet: tokens,
    score,
    reasons: [`openviking(${memory.score.toFixed(2)})`],
  };
}

export type { RankedMemoryChunk };
// Re-export so callers don't need to import from two places
export type { MemoryChunk };
