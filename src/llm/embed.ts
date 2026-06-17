/**
 * Client-side embeddings helper (v2 — memory retrieval relevance term).
 *
 * Contract rule 10: NEVER block a caller on the embeddings endpoint.
 * `embedTexts` resolves [] on ANY failure (network, non-200, malformed body,
 * count mismatch) and never throws — callers treat a missing embedding as
 * relevance 0 and move on. Batches at the proxy's 32-text cap.
 */
import type { EmbedResponse } from "@contracts/types";

/** Proxy cap per POST /api/embeddings call (contracts/openapi.yaml). */
export const EMBED_BATCH_SIZE = 32;

async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const res = await fetch("/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as Partial<EmbedResponse>;
  const embeddings = body?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) return null;
  for (const vec of embeddings) {
    if (!Array.isArray(vec) || vec.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return null;
    }
  }
  return embeddings as number[][];
}

/**
 * Embed `texts` via POST /api/embeddings, batching at 32 per call.
 * Resolves one vector per input text (same order), or [] on ANY failure —
 * including a single failed batch (a partial result would misalign
 * text↔vector indices for callers).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE));
      if (batch === null) return [];
      out.push(...batch);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cosine similarity. Returns 0 on length mismatch, empty inputs, or
 * zero-magnitude vectors (degenerate cases score as "no relevance" per the
 * retrieval formula in contracts/types.ts).
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
