/**
 * Retrieval scoring (contracts v2, MemoryStore doc):
 *
 *   score = w_rec * decay^hoursSince(lastAccess)
 *         + w_imp * importance/10
 *         + w_rel * cosine(queryEmb, memEmb)   (0 when either emb missing)
 *
 * Pure functions, exported separately from the store so the math is unit-
 * testable against hand-computed values (domain rule 10: the formula IS the
 * contract — equal weights, decay 0.995/game-hour, top-5 default).
 */
import type { GameStamp, MemoryEntry, RetrievalConfig } from "@contracts/types";
import { gameHours, RETRIEVAL_DEFAULTS } from "@contracts/types";
import { cosine } from "../../llm/embed";

/** Game-hours elapsed since the entry was last accessed (never negative). */
export function hoursSinceAccess(entry: MemoryEntry, now: GameStamp): number {
  return Math.max(0, gameHours(now) - gameHours(entry.lastAccess));
}

/** decay^hoursSince(lastAccess) — Park recency term in [0,1]. */
export function recencyScore(
  entry: MemoryEntry,
  now: GameStamp,
  decay: number = RETRIEVAL_DEFAULTS.decay,
): number {
  return decay ** hoursSinceAccess(entry, now);
}

/**
 * Full contract score for one memory. `queryEmb === undefined` (offline /
 * mock / unembedded query) zeroes the relevance term, as does a memory
 * without its own embedding (rule 10 degradation).
 */
export function scoreMemory(
  entry: MemoryEntry,
  now: GameStamp,
  queryEmb: number[] | undefined,
  cfg: RetrievalConfig = RETRIEVAL_DEFAULTS,
): number {
  const w = cfg.weights;
  const rec = w.recency * recencyScore(entry, now, cfg.decay);
  const imp = w.importance * (entry.importance / 10);
  const rel =
    queryEmb !== undefined && entry.embedding !== undefined
      ? w.relevance * cosine(queryEmb, entry.embedding)
      : 0;
  return rec + imp + rel;
}
