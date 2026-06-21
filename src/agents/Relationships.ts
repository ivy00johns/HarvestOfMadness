/**
 * RelationshipStore (contracts v2, AGA pattern) — asymmetric per-owner views
 * with immediate AFFINITY_DELTAS (TALK_TO +2, GIVE_GIFT +10), clamped to
 * ±100. Summary text refreshes LAZILY at most once per game-day per pair:
 * mock = deterministic template ("we talked N times; they gave me X gifts"),
 * live = a fire-and-forget smart-tier one-liner in the owner's voice (the
 * template stands in until/unless the call lands — never blocks anything).
 *
 * Every recordInteraction emits "relationship_updated".
 */
import type {
  EventBus,
  GameStamp,
  RelationshipStore,
  RelationshipSummary,
  Router,
} from "@contracts/types";
import { AFFINITY_DELTAS } from "@contracts/types";

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
/** Live summary one-liner budget (chars) — keeps cards readable. */
export const SUMMARY_MAX_CHARS = 140;

interface Row extends RelationshipSummary {
  talks: number;
  giftsReceived: number;
  giftsGiven: number;
  /** last game-day the summary text was refreshed (lazy once/day/pair) */
  lastSummaryDay: number;
}

export interface RelationshipDeps {
  bus: EventBus;
  live: () => boolean;
  router: Router;
  now: () => GameStamp;
  /** owner persona for the live one-liner prompt */
  persona?: (agentName: string) => string;
  /** notified after any row of `agentName` changes (inspector feed refresh) */
  onChange?: (agentName: string) => void;
  onLiveCall?: () => void;
}

export function clampAffinity(n: number): number {
  return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, n));
}

/** Deterministic template summary (mock + live placeholder). */
export function templateSummary(row: {
  talks: number;
  giftsReceived: number;
  giftsGiven: number;
}): string {
  const parts: string[] = [];
  parts.push(`we talked ${row.talks} time${row.talks === 1 ? "" : "s"}`);
  if (row.giftsReceived > 0) {
    parts.push(`they gave me ${row.giftsReceived} gift${row.giftsReceived === 1 ? "" : "s"}`);
  }
  if (row.giftsGiven > 0) {
    parts.push(`I gave them ${row.giftsGiven} gift${row.giftsGiven === 1 ? "" : "s"}`);
  }
  return parts.join("; ");
}

export class RelationshipStoreImpl implements RelationshipStore {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly deps: RelationshipDeps) {}

  private key(agentName: string, otherName: string): string {
    return `${agentName}|${otherName}`;
  }

  get(agentName: string, otherName: string): RelationshipSummary | null {
    return this.rows.get(this.key(agentName, otherName)) ?? null;
  }

  allFor(agentName: string): RelationshipSummary[] {
    return [...this.rows.values()].filter((r) => r.agentName === agentName);
  }

  /** Top-N rows for the Observation/card feed: newest-first, then strongest. */
  topFor(agentName: string, n = 5): RelationshipSummary[] {
    return [...this.rows.values()]
      .filter((r) => r.agentName === agentName)
      .sort(
        (a, b) =>
          b.updatedDay - a.updatedDay ||
          Math.abs(b.affinity) - Math.abs(a.affinity) ||
          a.otherName.localeCompare(b.otherName),
      )
      .slice(0, n);
  }

  recordInteraction(
    agentName: string,
    otherName: string,
    kind: "TALK_TO" | "GIVE_GIFT",
    eventText: string,
  ): void {
    if (agentName === otherName) return; // no self-relationships
    const today = this.deps.now().day;

    const k = this.key(agentName, otherName);
    let row = this.rows.get(k);
    if (!row) {
      row = {
        agentName,
        otherName,
        affinity: 0,
        summary: "we have not really gotten to know each other yet",
        interactions: 0,
        updatedDay: today,
        talks: 0,
        giftsReceived: 0,
        giftsGiven: 0,
        lastSummaryDay: 0,
      };
      this.rows.set(k, row);
    }

    const delta = AFFINITY_DELTAS[kind] ?? 0;
    row.affinity = clampAffinity(row.affinity + delta);
    row.interactions += 1;
    if (kind === "TALK_TO") row.talks += 1;
    else if (eventText.includes("gave me")) row.giftsReceived += 1;
    else row.giftsGiven += 1;
    row.updatedDay = today;

    this.refreshSummaryLazily(row, eventText, today);

    const t = this.deps.now();
    this.deps.bus.emit({
      day: t.day,
      phase: t.phase,
      kind: "relationship_updated",
      agentName,
      text: `${agentName} -> ${otherName}: affinity ${row.affinity} (${delta >= 0 ? "+" : ""}${delta})`,
      payload: { otherName, affinity: row.affinity, delta },
    });
    this.deps.onChange?.(agentName);
  }

  /**
   * Phase C · Slice C1 — apply a conversation-warmth bonus. Adjusts affinity
   * only (clamped); does NOT bump talks/interactions/gift counters (the talk was
   * already counted by the synchronous recordInteraction). Warmth-only: guards
   * bonus<=0 so it can never LOWER affinity. Emits the same "relationship_updated"
   * event shape { otherName, affinity, delta: bonus } so the feed + inspector
   * update, then notifies onChange. Defense-in-depth even though the only caller
   * passes a clamped positive bonus.
   */
  recordWarmth(
    agentName: string,
    otherName: string,
    bonus: number,
    eventText: string,
  ): void {
    if (agentName === otherName) return; // no self-relationships
    if (!Number.isFinite(bonus) || bonus <= 0) return; // warmth-only: never lowers

    // Warmth only ADJUSTS an already-counted talk: onTalk runs recordInteraction
    // for both directions synchronously BEFORE this fire-and-forget path, so the
    // row always exists here. If it somehow doesn't, there was no talk to warm —
    // do nothing rather than synthesize a misleading "we talked 0 times" row.
    const row = this.rows.get(this.key(agentName, otherName));
    if (!row) return;

    const today = this.deps.now().day;
    row.affinity = clampAffinity(row.affinity + bonus);
    row.updatedDay = today;
    // Same-day this no-ops (lastSummaryDay already today after recordInteraction);
    // a warmth tweak need not change the one-liner — match recordInteraction.
    this.refreshSummaryLazily(row, eventText, today);

    const t = this.deps.now();
    this.deps.bus.emit({
      day: t.day,
      phase: t.phase,
      kind: "relationship_updated",
      agentName,
      text: `${agentName} -> ${otherName}: affinity ${row.affinity} (+${bonus})`,
      payload: { otherName, affinity: row.affinity, delta: bonus },
    });
    this.deps.onChange?.(agentName);
  }

  /** At most one summary refresh per pair per game-day. */
  private refreshSummaryLazily(row: Row, eventText: string, today: number): void {
    if (row.lastSummaryDay === today) return;
    row.lastSummaryDay = today;
    row.summary = templateSummary(row);

    if (!this.deps.live()) return;
    // Live: fire-and-forget smart one-liner in the owner's voice; the
    // template above stands until (and unless) this lands.
    try {
      this.deps.onLiveCall?.();
      const persona = this.deps.persona?.(row.agentName) ?? "a farmer";
      void this.deps
        .router({
          agentId: row.agentName,
          system:
            `You are ${row.agentName}: ${persona}\n` +
            "Respond with ONLY one short first-person sentence — no quotes, no fences.",
          user:
            `In one sentence (max 20 words), in your own voice, summarize how you feel about ${row.otherName}. ` +
            `Facts: ${templateSummary(row)}; affinity ${row.affinity} of 100; latest: ${eventText}.`,
          tier: "smart",
        })
        .then((res) => {
          if (res.error) return;
          const line = sanitizeOneLiner(res.raw);
          if (line) {
            row.summary = line;
            this.deps.onChange?.(row.agentName);
          }
        })
        .catch(() => {
          /* never let a summary refresh surface anywhere */
        });
    } catch {
      /* router factory hiccup — template already in place */
    }
  }
}

/** First non-empty line, quotes/fences stripped, truncated to budget. */
export function sanitizeOneLiner(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const line = raw
    .replace(/```[a-z]*\n?/gi, "")
    .split("\n")
    .map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, ""))
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > SUMMARY_MAX_CHARS
    ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : line;
}
