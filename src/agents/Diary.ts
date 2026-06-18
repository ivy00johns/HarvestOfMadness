/**
 * DiarySystem (additive subsystem, modeled EXACTLY on the reflection engine in
 * Reflection.ts) — each agent writes ONE short first-person journal entry at the
 * end of each game-day, generated from their memory stream.
 *
 * Live (fast/smart tier): the day's memories -> buildDiaryPrompt -> ONE router
 * call -> a sanitized first-person entry. Mock OR any failure -> mockDiary
 * (deterministic template). One-entry-per-agent-per-day is guarded so a re-run
 * (or multiple sleepers crossing the same boundary) never double-writes.
 *
 * Defensive end to end (rule 10): every method is try/wrapped and NEVER throws
 * into the cognition loop. A diary failure degrades to the $0 mock entry or a
 * no-op; it must never take the pipeline down. The entry is stored per-agent and
 * a `diary` bus event is emitted so it surfaces in the existing event feed.
 */
import type {
  DiaryEntry,
  EventBus,
  GameStamp,
  MemoryEntry,
  MemoryStore,
  Router,
} from "@contracts/types";
import { mockDiary } from "../llm/mock";
import { buildDiaryPrompt } from "../llm/prompts";

/** How many of the day's memories feed the diary prompt (newest kept). */
export const DIARY_RECENT_WINDOW = 20;
/** Fallback window (entries) when no memory carries the just-ended day's stamp. */
export const DIARY_FALLBACK_WINDOW = 10;
/** Max characters retained for a generated entry (defensive trim). */
export const DIARY_MAX_CHARS = 280;

export interface DiaryDeps {
  store: MemoryStore;
  bus: EventBus;
  live: () => boolean;
  router: Router;
  now: () => GameStamp;
  /** metrics hook: bumped once per LIVE diary call (mock path never calls it). */
  onLiveCall?: () => void;
}

/** Per-agent ordered store of diary entries (oldest-first, append order). */
export class DiaryStore {
  private readonly byAgent = new Map<string, DiaryEntry[]>();

  add(agentName: string, entry: DiaryEntry): void {
    const list = this.byAgent.get(agentName);
    if (list) {
      list.push(entry);
    } else {
      this.byAgent.set(agentName, [entry]);
    }
  }

  /** Defensive copy, oldest-first. */
  entries(agentName: string): DiaryEntry[] {
    return (this.byAgent.get(agentName) ?? []).slice();
  }

  latest(agentName: string): DiaryEntry | null {
    const list = this.byAgent.get(agentName);
    return list && list.length > 0 ? list[list.length - 1] : null;
  }

  /** True once an entry already exists for this agent on `day`. */
  hasForDay(agentName: string, day: number): boolean {
    const list = this.byAgent.get(agentName);
    return list ? list.some((e) => e.day === day) : false;
  }
}

export class DiarySystem {
  private readonly store = new DiaryStore();
  private readonly inProgress = new Set<string>();

  constructor(private readonly deps: DiaryDeps) {}

  /**
   * Write the end-of-day entry for the day that just ended. No-op (returns null)
   * if one already exists for that day, if the agent is mid-write, or on any
   * failure. Otherwise stores the entry, emits a `diary` bus event, returns it.
   */
  async writeEntry(agentName: string): Promise<DiaryEntry | null> {
    try {
      if (this.inProgress.has(agentName)) return null;
      const day = this.justEndedDay();
      if (this.store.hasForDay(agentName, day)) return null;

      this.inProgress.add(agentName);
      try {
        const memories = this.memoriesForDay(agentName, day);
        const text = this.deps.live()
          ? await this.composeLive(agentName, memories)
          : this.composeMock(agentName, memories);
        const entry: DiaryEntry = { day, phase: this.deps.now().phase, text };
        this.store.add(agentName, entry);
        this.emitDiary(agentName, entry);
        return entry;
      } finally {
        this.inProgress.delete(agentName);
      }
    } catch {
      // A diary write must never take the pipeline down.
      return null;
    }
  }

  /** Read all entries for an agent, oldest-first (defensive copy). */
  entries(agentName: string): DiaryEntry[] {
    try {
      return this.store.entries(agentName);
    } catch {
      return [];
    }
  }

  /** The newest diary entry for an agent, or null. */
  latest(agentName: string): DiaryEntry | null {
    try {
      return this.store.latest(agentName);
    } catch {
      return null;
    }
  }

  // -- internals -------------------------------------------------------------

  /** The day that just ended = now().day - 1 (min 1, so a same-day call is sane). */
  private justEndedDay(): number {
    const today = this.deps.now().day;
    return today > 1 ? today - 1 : today;
  }

  /**
   * The agent's memories for `day` (non-plan), newest kept. Falls back to a
   * recent window when nothing carries that exact stamp (so the entry is never
   * starved by an off-by-one or a fresh agent).
   */
  private memoriesForDay(agentName: string, day: number): MemoryEntry[] {
    const all = this.deps.store.all(agentName).filter((m) => m.type !== "plan");
    const sameDay = all.filter((m) => m.createdAt?.day === day);
    const pool = sameDay.length > 0 ? sameDay : all.slice(-DIARY_FALLBACK_WINDOW);
    return pool.slice(-DIARY_RECENT_WINDOW);
  }

  private composeMock(agentName: string, memories: MemoryEntry[]): string {
    const r = mockDiary(agentName, memories.map(({ text }) => ({ text })));
    return this.sanitize(r.text);
  }

  private async composeLive(agentName: string, memories: MemoryEntry[]): Promise<string> {
    const { router, onLiveCall } = this.deps;
    if (memories.length === 0) return this.composeMock(agentName, memories);
    try {
      onLiveCall?.();
      const res = await router({
        agentId: agentName,
        system:
          `You are ${agentName}, a farmer NPC writing a short private journal entry. ` +
          "Respond with ONLY the entry as plain text — no quotes, no JSON, no fences.",
        user: buildDiaryPrompt(agentName, memories.map((m) => m.text)),
        tier: "fast",
      });
      if (res.error) return this.composeMock(agentName, memories);
      const text = this.sanitize(res.raw);
      return text.length > 0 ? text : this.composeMock(agentName, memories);
    } catch {
      return this.composeMock(agentName, memories);
    }
  }

  /** Collapse whitespace, strip wrapping quotes/fences, cap length. Never throws. */
  private sanitize(raw: unknown): string {
    let s = typeof raw === "string" ? raw : "";
    s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    s = s.replace(/\s+/g, " ").trim();
    // strip a single layer of wrapping quotes
    if (s.length >= 2 && /^["'“”].*["'“”]$/.test(s)) s = s.slice(1, -1).trim();
    if (s.length > DIARY_MAX_CHARS) s = `${s.slice(0, DIARY_MAX_CHARS - 1).trimEnd()}…`;
    return s;
  }

  private emitDiary(agentName: string, entry: DiaryEntry): void {
    try {
      const t = this.deps.now();
      this.deps.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "diary",
        agentName,
        text: `${agentName}'s journal: ${entry.text}`,
        payload: { day: entry.day, phase: entry.phase, text: entry.text },
      });
    } catch {
      /* defensive — an emit failure must not drop the stored entry */
    }
  }
}
