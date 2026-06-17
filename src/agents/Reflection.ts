/**
 * ReflectionEngine (contracts v2, rule 11) — fires when summed observation
 * importance since the last reflection crosses REFLECTION_IMPORTANCE_THRESHOLD.
 *
 * Live (smart tier): salient questions -> retrieve evidence -> insights with
 * sourceIds. Budget discipline: ONE questions call + insights for the TOP
 * question only (2 smart calls per reflection), and a hard per-game-day cap
 * so cadence stays at the contract's ~2-3x/day even in a memory storm.
 * Every parse is defensive; any garbage degrades to the $0 mock reflection.
 *
 * Mock: mockReflection — templated, deterministic, keeps the whole pipeline
 * testable with the server down (rule 11).
 *
 * Reflections are stored as `reflection` memories via the cognition layer's
 * write callback (which emits memory_written, bumps counters, and resets the
 * importance accumulator via the store).
 */
import type {
  EventBus,
  GameStamp,
  MemoryEntry,
  MemoryStore,
  ReflectionEngine,
  Router,
} from "@contracts/types";
import { REFLECTION_IMPORTANCE_THRESHOLD } from "@contracts/types";
import { mockReflection } from "../llm/mock";
import {
  buildReflectionInsightsPrompt,
  buildReflectionQuestionsPrompt,
} from "../llm/prompts";
import { parseInsights, parseStringArray } from "./llmJson";

/** Cadence guard (contract: threshold 30 ≈ 2-3 reflections/game-day). */
export const MAX_REFLECTIONS_PER_DAY = 3;
/** How many recent (non-plan) memories feed the questions prompt. */
export const REFLECTION_RECENT_WINDOW = 20;
/** Max insights stored per reflection (mirrors the insights prompt). */
export const MAX_INSIGHTS = 5;
/** Evidence memories retrieved for the insights step. */
export const REFLECTION_EVIDENCE_K = 8;
/**
 * Fixed poignancy for reflection memories: inherently salient (they compete
 * in retrieval against importance-7 gifts) but never LLM-rated — rating
 * every insight would blow the per-day call budget.
 */
export const REFLECTION_IMPORTANCE = 6;

export interface ReflectionDeps {
  store: MemoryStore;
  /** appends a `reflection` memory (cognition layer wiring; null on failure) */
  write: (
    agentName: string,
    text: string,
    importance: number,
    sourceIds: string[],
  ) => Promise<MemoryEntry | null>;
  bus: EventBus;
  live: () => boolean;
  router: Router;
  now: () => GameStamp;
  onLiveCall?: () => void;
}

export class ReflectionEngineImpl implements ReflectionEngine {
  private readonly inProgress = new Set<string>();
  private readonly perDay = new Map<string, { day: number; count: number }>();

  constructor(private readonly deps: ReflectionDeps) {}

  async maybeReflect(agentName: string): Promise<MemoryEntry[]> {
    const { store, now } = this.deps;
    if (this.inProgress.has(agentName)) return [];
    if (store.importanceSinceReflection(agentName) < REFLECTION_IMPORTANCE_THRESHOLD) {
      return [];
    }
    const day = now().day;
    const tally = this.perDay.get(agentName);
    const count = tally?.day === day ? tally.count : 0;
    if (count >= MAX_REFLECTIONS_PER_DAY) return [];

    this.inProgress.add(agentName);
    try {
      const entries = this.deps.live()
        ? await this.reflectLive(agentName)
        : await this.reflectMock(agentName);
      if (entries.length > 0) this.perDay.set(agentName, { day, count: count + 1 });
      return entries;
    } catch {
      return []; // reflection must never take the pipeline down
    } finally {
      this.inProgress.delete(agentName);
    }
  }

  private recent(agentName: string): MemoryEntry[] {
    return this.deps.store
      .all(agentName)
      .filter((m) => m.type !== "plan")
      .slice(-REFLECTION_RECENT_WINDOW);
  }

  private emitReflection(
    agentName: string,
    insightIds: string[],
    questions?: string[],
  ): void {
    const t = this.deps.now();
    this.deps.bus.emit({
      day: t.day,
      phase: t.phase,
      kind: "reflection",
      agentName,
      text: `${agentName} reflected on recent events (${insightIds.length} insight${insightIds.length === 1 ? "" : "s"})`,
      payload: { ...(questions ? { questions } : {}), insightIds },
    });
  }

  private async reflectMock(agentName: string): Promise<MemoryEntry[]> {
    const recent = this.recent(agentName);
    const r = mockReflection(
      agentName,
      recent.map(({ id, text }) => ({ id, text })),
    );
    const entry = await this.deps.write(
      agentName,
      r.text,
      REFLECTION_IMPORTANCE,
      r.sourceIds,
    );
    if (!entry) return [];
    this.emitReflection(agentName, [entry.id]);
    return [entry];
  }

  private async reflectLive(agentName: string): Promise<MemoryEntry[]> {
    const { router, store, onLiveCall } = this.deps;
    const recent = this.recent(agentName);
    if (recent.length === 0) return [];

    const system =
      `You are ${agentName}, a farmer NPC reflecting on your recent experiences. ` +
      "Respond with ONLY the requested JSON — no prose, no fences.";

    // Step 1 — salient questions (one smart call; we ask for 3, use the top one).
    onLiveCall?.();
    const qRes = await router({
      agentId: agentName,
      system,
      user: buildReflectionQuestionsPrompt(recent.map((m) => m.text)),
      tier: "smart",
    });
    const questions = qRes.error ? [] : parseStringArray(qRes.raw, 3);
    if (questions.length === 0) return this.reflectMock(agentName);
    const question = questions[0];

    // Step 2 — retrieve evidence, then insights with sourceIds (one smart call).
    const retrieved = await store.retrieve(agentName, question, REFLECTION_EVIDENCE_K);
    const evidence = retrieved.length > 0 ? retrieved : recent.slice(-REFLECTION_EVIDENCE_K);

    onLiveCall?.();
    const iRes = await router({
      agentId: agentName,
      system,
      user: buildReflectionInsightsPrompt(
        question,
        evidence.map(({ id, text }) => ({ id, text })),
      ),
      tier: "smart",
    });
    const knownIds = new Set(store.all(agentName).map((m) => m.id));
    const insights = iRes.error
      ? []
      : parseInsights(iRes.raw, knownIds, MAX_INSIGHTS);
    if (insights.length === 0) return this.reflectMock(agentName);

    const entries: MemoryEntry[] = [];
    for (const ins of insights) {
      const entry = await this.deps.write(
        agentName,
        ins.insight,
        REFLECTION_IMPORTANCE,
        ins.sourceIds,
      );
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) return this.reflectMock(agentName);
    this.emitReflection(agentName, entries.map((e) => e.id), questions);
    return entries;
  }
}
