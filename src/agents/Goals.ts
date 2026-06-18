/**
 * GoalsSystem (Wave 3a, PIANO keystone) — synthesizes a standing goal from an
 * agent's intrinsic drives + recent memories, then feeds it to the planner as
 * a prompt INPUT. Strictly additive, fire-and-forget, mock-fallback.
 *
 * Cadence (NOT per-decision — avoids LLM thrash):
 *  - (a) new-day morning: force a refresh;
 *  - (b) a drive crossing DRIVE_URGENT (0.75) into a NEW dominant drive
 *    (differs from the cached `drivenBy`) re-derives;
 *  - otherwise: return the cached goal (synchronous, never re-derives).
 *
 * Live path: buildGoalPrompt → router(tier:"smart"); on error / empty /
 * over-long the result falls back to mockGoal. Output is sanitized to a
 * single line ≤120 chars. Per-(agent,day) inflight guard mirrors
 * Planner.inflight so concurrent refreshes dedupe. Never throws.
 */
import type { GameStamp, NeedState, Router } from "@contracts/types";
import { buildGoalPrompt } from "../llm/prompts";
import { dominantDrive, mockGoal } from "../llm/mock";
import { DRIVE_URGENT } from "./Needs";

/** Max length of a synthesized goal line. */
export const GOAL_MAX_CHARS = 120;

export interface GoalsDeps {
  live: () => boolean;
  router: Router;
  now: () => GameStamp;
  persona: (agentName: string) => string;
  /** defensive copy of the agent's current drive vector */
  needs: (agentName: string) => NeedState;
  /** top-k memory texts for the goal prompt (cheap, optional) */
  topMemories: (agentName: string) => string[];
  onLiveCall?: () => void;
}

interface GoalCacheEntry {
  day: number;
  text: string;
  /** the dominant drive that drove this goal — used for threshold-cross detection */
  drivenBy: string;
}

/** Collapse to a single trimmed line, capped at GOAL_MAX_CHARS. */
function sanitizeGoal(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > GOAL_MAX_CHARS ? oneLine.slice(0, GOAL_MAX_CHARS).trim() : oneLine;
}

export class GoalsSystem {
  private readonly cache = new Map<string, GoalCacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly deps: GoalsDeps) {}

  /** Cheap synchronous cached read — null until the first refresh resolves. */
  current(name: string): string | null {
    return this.cache.get(name)?.text ?? null;
  }

  /**
   * Refresh the goal under the cadence gate. Returns the (possibly cached)
   * goal text. Never throws — any failure degrades to the cached goal, then
   * the mock goal, then a safe fallback string.
   */
  async refresh(name: string, opts: { force?: boolean } = {}): Promise<string> {
    try {
      const day = this.deps.now().day;
      const cached = this.cache.get(name);
      const needs = this.deps.needs(name);
      const dom = dominantDrive(needs);

      // Cadence gate: refresh only on force OR a threshold-cross into a NEW
      // dominant drive. Otherwise return the cached goal verbatim.
      const thresholdCross =
        cached !== undefined &&
        (needs?.[dom] ?? 0) >= DRIVE_URGENT &&
        dom !== cached.drivenBy;

      if (cached && !opts.force && !thresholdCross) {
        return cached.text;
      }

      // Per-(agent,day) inflight guard — concurrent refreshes dedupe.
      const key = `${name}|${day}`;
      let p = this.inflight.get(key);
      if (!p) {
        p = this.derive(name, day, needs, dom).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
      }
      return p;
    } catch {
      const fallback = this.cache.get(name)?.text;
      return fallback ?? "tend the farm and get through the day";
    }
  }

  private async derive(
    name: string,
    day: number,
    needs: NeedState,
    dom: string,
  ): Promise<string> {
    let text: string;
    try {
      const persona = this.deps.persona(name);
      if (this.deps.live()) {
        const live = await this.deriveLive(name, persona, needs);
        text = live ?? mockGoal(persona, needs, day);
      } else {
        text = mockGoal(persona, needs, day);
      }
    } catch {
      // Last resort — mockGoal is deterministic and never throws, but be safe.
      try {
        text = mockGoal(this.deps.persona(name), needs, day);
      } catch {
        text = "tend the farm and get through the day";
      }
    }
    this.cache.set(name, { day, text, drivenBy: dom });
    return text;
  }

  /** ONE smart-tier call; null on error / empty / over-long → caller mock-falls-back. */
  private async deriveLive(
    name: string,
    persona: string,
    needs: NeedState,
  ): Promise<string | null> {
    try {
      this.deps.onLiveCall?.();
      const res = await this.deps.router({
        agentId: name,
        system:
          `You are ${name}, a farmer NPC choosing a standing goal for your day. ` +
          "Respond with ONLY one short plain-text sentence — no prose preamble, no JSON, no fences.",
        user: buildGoalPrompt(persona, needs, this.deps.topMemories(name)),
        tier: "smart",
      });
      if (res.error) return null;
      const cleaned = sanitizeGoal(res.raw ?? "");
      if (cleaned.length === 0) return null;
      // Over-long raw output (before sanitizing) is treated as malformed.
      if ((res.raw ?? "").length > 400) return null;
      return cleaned;
    } catch {
      return null;
    }
  }
}
