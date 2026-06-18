/**
 * InMemoryMemoryStore — the contract MemoryStore (v2 cognition).
 *
 * - append assigns `${agentName}-m${counter}` ids (per-agent counter) and
 *   lastAccess = createdAt; the embedding is requested FIRE-AND-FORGET via
 *   embedTexts (rule 10: never block, never throw — the entry is fully
 *   functional without it). Embedding requests are skipped entirely in mock
 *   mode (the endpoint is presumed down; relevance is 0 by contract).
 * - retrieve scores every memory with the contract formula (retrieval.ts),
 *   returns top-k (default RETRIEVAL_DEFAULTS.topK) and bumps lastAccess on
 *   the returned entries (Park recency semantics). The QUERY embedding is
 *   only attempted when at least one candidate memory actually has an
 *   embedding, is cached per query text, and is bounded by a short timeout
 *   so a slow endpoint can never stall a decision (rule 10).
 * - importanceSinceReflection sums observation importance since the last
 *   reflection append (the reflection trigger input).
 */
import type {
  GameStamp,
  MemoryEntry,
  MemoryStore,
  RetrievalConfig,
} from "@contracts/types";
import { gameHours, RETRIEVAL_DEFAULTS } from "@contracts/types";
import { EMBED_BATCH_SIZE, embedTexts } from "../../llm/embed";
import { scoreMemory } from "./retrieval";

/** Max ms a retrieve() will wait for the query embedding before scoring with relevance 0. */
export const QUERY_EMBED_WAIT_MS = 800;

/**
 * Micro-batch debounce window (Fix C, 429-storm resilience). On the first
 * queued append we schedule a drain after this many ms; every other append in
 * the same window joins the batch, collapsing a burst of writes (recordOutcome
 * + recordSpeech + recordNearbyActivity + ... per decision) into ONE
 * embedTexts() call. A 0ms window coalesces a synchronous burst in the same
 * tick into a single macrotask drain (spec-permitted microtask coalescing)
 * while keeping embedding latency negligible.
 */
export const EMBED_BATCH_DEBOUNCE_MS = 0;

export interface MemoryStoreDeps {
  /** game clock — defaults to a day-1-morning stub; the cognition layer injects the world clock */
  now?: () => GameStamp;
  /** gate for embedding requests (mock/offline => false). Default: false (mock-first). */
  live?: () => boolean;
  /** embedding fn override (tests). Default: src/llm embedTexts ([] on failure, never throws). */
  embed?: (texts: string[]) => Promise<number[][]>;
  config?: Partial<RetrievalConfig>;
  /** query-embedding wait bound override (tests) */
  queryEmbedWaitMs?: number;
  /** micro-batch debounce window for append embeddings (tests); default EMBED_BATCH_DEBOUNCE_MS */
  embedBatchDebounceMs?: number;
}

const DEFAULT_NOW = (): GameStamp => ({ day: 1, phase: "morning" });

export class InMemoryMemoryStore implements MemoryStore {
  private readonly byAgent = new Map<string, MemoryEntry[]>();
  private readonly counters = new Map<string, number>();
  private readonly importanceAcc = new Map<string, number>();
  /** query text -> embedding (null = attempted and failed/absent) */
  private readonly queryEmbCache = new Map<string, number[] | null>();
  private readonly queryEmbInflight = new Map<string, Promise<number[] | null>>();

  private readonly now: () => GameStamp;
  private readonly live: () => boolean;
  private readonly embed: (texts: string[]) => Promise<number[][]>;
  private readonly config: RetrievalConfig;
  private readonly queryEmbedWaitMs: number;
  private readonly embedBatchDebounceMs: number;

  /** Pending fire-and-forget embedding writes, drained as one batched call. */
  private readonly embedQueue: Array<{ entry: MemoryEntry; text: string }> = [];
  private embedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: MemoryStoreDeps = {}) {
    this.now = deps.now ?? DEFAULT_NOW;
    this.live = deps.live ?? (() => false);
    this.embed = deps.embed ?? embedTexts;
    this.config = { ...RETRIEVAL_DEFAULTS, ...deps.config };
    this.queryEmbedWaitMs = deps.queryEmbedWaitMs ?? QUERY_EMBED_WAIT_MS;
    this.embedBatchDebounceMs = deps.embedBatchDebounceMs ?? EMBED_BATCH_DEBOUNCE_MS;
  }

  async append(
    e: Omit<MemoryEntry, "id" | "lastAccess" | "embedding">,
  ): Promise<MemoryEntry> {
    const counter = (this.counters.get(e.agentName) ?? 0) + 1;
    this.counters.set(e.agentName, counter);

    const entry: MemoryEntry = {
      ...e,
      id: `${e.agentName}-m${counter}`,
      createdAt: { ...e.createdAt },
      lastAccess: { ...e.createdAt },
    };

    const list = this.byAgent.get(e.agentName) ?? [];
    list.push(entry);
    this.byAgent.set(e.agentName, list);

    // Reflection trigger accounting: observations accumulate, a reflection
    // append resets (plans neither add nor reset).
    if (entry.type === "reflection") {
      this.importanceAcc.set(e.agentName, 0);
    } else if (entry.type === "observation") {
      this.importanceAcc.set(
        e.agentName,
        (this.importanceAcc.get(e.agentName) ?? 0) + entry.importance,
      );
    }

    // Rule 10: fire-and-forget embedding — the entry works without it, and
    // a failed/slow endpoint never surfaces here. Skipped in mock mode.
    // Fix C: instead of one POST per write, enqueue and micro-batch — a burst
    // of writes in a tick collapses into a single embedTexts() call.
    if (this.live()) this.enqueueEmbedding(entry);

    return entry;
  }

  /**
   * Stop the micro-batch timer (test/teardown). Flushing is best-effort and
   * fire-and-forget, so we simply cancel any pending drain to avoid leaking an
   * open handle; queued entries stay functional without their embedding.
   */
  stop(): void {
    if (this.embedTimer !== null) {
      clearTimeout(this.embedTimer);
      this.embedTimer = null;
    }
    this.embedQueue.length = 0;
  }

  /** Queue an entry for batched embedding; schedule a drain on the first push. */
  private enqueueEmbedding(entry: MemoryEntry): void {
    this.embedQueue.push({ entry, text: entry.text });
    if (this.embedTimer === null) {
      this.embedTimer = setTimeout(() => {
        this.embedTimer = null;
        void this.drainEmbedQueue();
      }, this.embedBatchDebounceMs);
    }
  }

  /**
   * Drain the pending queue in chunks of EMBED_BATCH_SIZE — one embedTexts()
   * call per chunk (embed.ts batches at 32) — assigning each vector back to its
   * entry by index. Fire-and-forget + never-throw (rule 10): a failed/slow
   * batch just leaves those entries unembedded.
   */
  private async drainEmbedQueue(): Promise<void> {
    const pending = this.embedQueue.splice(0);
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const chunk = pending.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vecs = await this.embed(chunk.map((p) => p.text));
        if (Array.isArray(vecs) && vecs.length === chunk.length) {
          chunk.forEach((p, j) => {
            if (Array.isArray(vecs[j])) p.entry.embedding = vecs[j];
          });
        }
      } catch {
        /* embedTexts never throws, but a test stub might — degrade, never surface */
      }
    }
  }

  async retrieve(
    agentName: string,
    query: string,
    k: number = this.config.topK,
  ): Promise<MemoryEntry[]> {
    const list = this.byAgent.get(agentName) ?? [];
    if (list.length === 0 || k <= 0) return [];

    const queryEmb = await this.queryEmbedding(query, list);
    const now = this.now();

    const scored = list
      .map((m) => ({ m, score: scoreMemory(m, now, queryEmb, this.config) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          gameHours(b.m.createdAt) - gameHours(a.m.createdAt) ||
          a.m.id.localeCompare(b.m.id),
      );

    const top = scored.slice(0, k).map((s) => s.m);
    for (const m of top) m.lastAccess = { ...now }; // bump AFTER scoring
    return top;
  }

  all(agentName: string): MemoryEntry[] {
    return [...(this.byAgent.get(agentName) ?? [])];
  }

  importanceSinceReflection(agentName: string): number {
    return this.importanceAcc.get(agentName) ?? 0;
  }

  /**
   * Best-effort query embedding: only attempted when some candidate memory
   * is embedded (otherwise the relevance term is 0 for everyone anyway),
   * cached per query, and bounded by queryEmbedWaitMs — a late result still
   * lands in the cache for the NEXT retrieve (never blocks this one).
   */
  private async queryEmbedding(
    query: string,
    candidates: MemoryEntry[],
  ): Promise<number[] | undefined> {
    if (!candidates.some((c) => c.embedding !== undefined)) return undefined;

    const cached = this.queryEmbCache.get(query);
    if (cached !== undefined) return cached ?? undefined;

    let inflight = this.queryEmbInflight.get(query);
    if (!inflight) {
      inflight = this.embed([query])
        .then((vecs) => {
          const emb = Array.isArray(vecs) && vecs.length === 1 ? vecs[0] : null;
          this.queryEmbCache.set(query, emb);
          return emb;
        })
        .catch(() => {
          this.queryEmbCache.set(query, null);
          return null;
        })
        .finally(() => {
          this.queryEmbInflight.delete(query);
        });
      this.queryEmbInflight.set(query, inflight);
    }

    const timeout = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), this.queryEmbedWaitMs),
    );
    const winner = await Promise.race([inflight, timeout]);
    return winner ?? undefined;
  }
}
