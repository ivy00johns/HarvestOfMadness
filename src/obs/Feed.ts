/**
 * Feed — the v2 spectator feed model. Pure logic, no Phaser.
 *
 * Fixes the v1 "event log floods" defect:
 *   - one decision turn (turn_start/llm_call/action_chosen/action_resolved/
 *     parse_failure sharing a turnId) collapses into ONE summary line that
 *     updates in place as the chain progresses; the full chain stays
 *     inspectable via the agent's decision-trace panel (turn lines are
 *     clickable and open it).
 *   - "— Day N —" separator lines are inserted on day_advanced (deduped per
 *     day; the SLEEP itself still reads from the turn summary).
 *   - chatty kinds are suppressed: memory_written (counted for the card's
 *     "M:" stat only), agent_emote (cards/world render it), and
 *     relationship_updated below |delta| ≥ RELATIONSHIP_DELTA_MIN.
 *
 * Contract: EventKind is an open string union — unknown kinds MUST render
 * (default color), never throw.
 */
import type { EventBus, Phase, WorldEvent } from "@contracts/types";
import { eventColor, formatEventLine, formatStamp, kindColor } from "./EventLog";

/** UI display cap; the bus ring buffer (cap 1000) remains the real history. */
export const FEED_DISPLAY_CAP = 100;

/** relationship_updated lines only render at |delta| ≥ this (flood guard). */
export const RELATIONSHIP_DELTA_MIN = 10;

/** Decision-chain kinds that collapse into one turn line. */
export const TURN_CHAIN_KINDS: ReadonlySet<string> = new Set([
  "turn_start",
  "llm_call",
  "action_chosen",
  "action_resolved",
  "parse_failure",
]);

/** Kinds that never render a feed line. */
export const SUPPRESSED_KINDS: ReadonlySet<string> = new Set([
  "memory_written", // far too chatty — counted for the M: stat only
  "agent_emote", // cards/world show it
]);

export interface TurnFeedItem {
  type: "turn";
  turnId: string;
  agentName: string;
  day: number;
  phase: Phase;
  model: string | null;
  latencyMs: number | null;
  action: string | null;
  /** null while the turn is still in flight */
  ok: boolean | null;
  reason: string | null;
  parseFailed: boolean;
  error: string | null;
}

export interface SeparatorFeedItem {
  type: "separator";
  day: number;
}

export interface EventFeedItem {
  type: "event";
  event: WorldEvent;
}

export type FeedItem = TurnFeedItem | SeparatorFeedItem | EventFeedItem;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export class FeedModel {
  /** newest-first */
  private items: FeedItem[] = [];
  private readonly turnsById = new Map<string, TurnFeedItem>();
  private lastSeparatorDay = 0;
  private readonly memCounts = new Map<string, number>();
  private readonly reflCounts = new Map<string, number>();

  constructor(private readonly cap: number = FEED_DISPLAY_CAP) {}

  /** Seed from bus.recent() (newest-last) then follow live; returns unsub. */
  attach(bus: EventBus): () => void {
    for (const e of bus.recent()) this.push(e);
    return bus.on((e) => this.push(e));
  }

  push(e: WorldEvent): void {
    const kind = e.kind;
    // suppressed-but-counted kinds first
    if (kind === "memory_written") {
      if (e.agentName) this.bump(this.memCounts, e.agentName);
      return;
    }
    if (SUPPRESSED_KINDS.has(kind)) return;
    if (kind === "reflection" && e.agentName) {
      this.bump(this.reflCounts, e.agentName); // counts AND renders
    }
    if (kind === "relationship_updated") {
      const delta = num(e.payload?.delta);
      if (delta === null || Math.abs(delta) < RELATIONSHIP_DELTA_MIN) return;
      this.insert({ type: "event", event: e });
      return;
    }
    if (kind === "day_advanced") {
      const day = num(e.payload?.day) ?? e.day;
      if (day !== this.lastSeparatorDay) {
        this.lastSeparatorDay = day;
        this.insert({ type: "separator", day });
      }
      return;
    }
    if (TURN_CHAIN_KINDS.has(kind) && e.turnId && e.agentName) {
      this.applyTurnEvent(e);
      return;
    }
    this.insert({ type: "event", event: e });
  }

  /** Newest-first snapshot (copy), optionally limited. */
  list(limit?: number): FeedItem[] {
    return limit === undefined
      ? this.items.slice()
      : this.items.slice(0, Math.max(0, limit));
  }

  size(): number {
    return this.items.length;
  }

  /** memory_written events seen for this agent (feeds the "M:" card stat). */
  memoryCount(agentName: string): number {
    return this.memCounts.get(agentName) ?? 0;
  }

  /** reflection events seen for this agent (feeds the "R:" card stat). */
  reflectionCount(agentName: string): number {
    return this.reflCounts.get(agentName) ?? 0;
  }

  // -- internals --------------------------------------------------------------

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private applyTurnEvent(e: WorldEvent): void {
    const turnId = e.turnId as string;
    let t = this.turnsById.get(turnId);
    if (!t) {
      t = {
        type: "turn",
        turnId,
        agentName: e.agentName as string,
        day: e.day,
        phase: e.phase,
        model: null,
        latencyMs: null,
        action: null,
        ok: null,
        reason: null,
        parseFailed: false,
        error: null,
      };
      this.turnsById.set(turnId, t);
      this.insert(t);
    }
    const p = e.payload ?? {};
    switch (e.kind) {
      case "llm_call":
        t.model = str(p.model) ?? t.model;
        t.latencyMs = num(p.latencyMs) ?? t.latencyMs;
        t.error = str(p.error); // a successful retry clears the error
        break;
      case "action_chosen":
        t.action = str(p.action) ?? t.action;
        break;
      case "action_resolved":
        t.action = str(p.action) ?? t.action;
        t.ok = typeof p.ok === "boolean" ? p.ok : true;
        t.reason = str(p.reason);
        break;
      case "parse_failure":
        t.parseFailed = true;
        break;
      default:
        break; // turn_start creates the item; nothing to merge
    }
  }

  private insert(item: FeedItem): void {
    this.items.unshift(item);
    if (this.items.length > this.cap) {
      for (const dropped of this.items.splice(this.cap)) {
        if (dropped.type === "turn") this.turnsById.delete(dropped.turnId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting — FeedItem → one colored line for the HUD
// ---------------------------------------------------------------------------

export interface FeedLineView {
  text: string;
  /** 0xRRGGBB */
  color: number;
  /** render bold / visually emphasized */
  emphasis: boolean;
  /** set on clickable turn lines (click opens this agent's trace panel) */
  agentName?: string;
}

const PENDING_COLOR = 0x6f7682;
const TURN_OK_COLOR = 0x9ece6a;
const TURN_FAIL_COLOR = 0xf7768e;
export const DAY_SEPARATOR_COLOR = 0xbb9af7;
const SPEECH_COLOR = 0xe0af68;

function clipLine(line: string, maxChars: number): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** "— Day N —" rendered wide enough to read as a section break. */
export function formatDaySeparator(day: number): string {
  return `────────────  Day ${day}  ────────────`;
}

/** One-line summary for a (possibly in-flight) collapsed decision turn. */
export function formatTurnLine(t: TurnFeedItem, maxChars: number): string {
  const stamp = formatStamp(t.day, t.phase);
  if (t.parseFailed && t.ok === null) {
    return clipLine(`${stamp} ${t.agentName}: parse failure → WAIT`, maxChars);
  }
  if (t.ok === null) {
    const meta = t.model ? ` (${t.model})` : "";
    return clipLine(`${stamp} ${t.agentName}: deciding…${meta}`, maxChars);
  }
  const outcome = t.ok ? "✓" : `✗ ${t.reason ?? "rejected"}`;
  const meta =
    t.model !== null
      ? ` · ${t.model}${t.latencyMs !== null ? ` ${t.latencyMs}ms` : ""}`
      : "";
  const err = t.error ? ` · err: ${t.error}` : "";
  return clipLine(
    `${stamp} ${t.agentName}: ${t.action ?? "—"} ${outcome}${meta}${err}`,
    maxChars,
  );
}

/** Project any feed item to its display line. Unknown kinds never throw. */
export function formatFeedItem(item: FeedItem, maxChars = 68): FeedLineView {
  if (item.type === "separator") {
    return {
      text: formatDaySeparator(item.day),
      color: DAY_SEPARATOR_COLOR,
      emphasis: true,
    };
  }
  if (item.type === "turn") {
    const failed = item.parseFailed || item.error !== null || item.ok === false;
    return {
      text: formatTurnLine(item, maxChars),
      color: item.ok === null && !item.parseFailed
        ? PENDING_COLOR
        : failed
          ? TURN_FAIL_COLOR
          : TURN_OK_COLOR,
      emphasis: false,
      agentName: item.agentName,
    };
  }

  const e = item.event;
  const stamp = formatStamp(e.day, e.phase);
  const p = e.payload ?? {};
  switch (e.kind) {
    case "agent_speech": {
      // dialogue is the most legible AI signal — name + quoted utterance, bold
      const say = str(p.say) ?? e.text;
      return {
        text: clipLine(`${stamp} 💬 ${e.agentName ?? "?"}: “${say}”`, maxChars),
        color: SPEECH_COLOR,
        emphasis: true,
        agentName: e.agentName,
      };
    }
    case "reflection": {
      const body = e.text || "reflects";
      return {
        text: clipLine(`${stamp} 💭 ${e.agentName ?? "?"}: ${body}`, maxChars),
        color: kindColor("reflection"),
        emphasis: false,
        agentName: e.agentName,
      };
    }
    case "plan_created": {
      const day = num(p.day) ?? e.day;
      const steps = Array.isArray(p.steps)
        ? (p.steps as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const body = steps.length > 0 ? steps.join(" → ") : e.text;
      return {
        text: clipLine(
          `${stamp} 📋 ${e.agentName ?? "?"} D${day} plan: ${body}`,
          maxChars,
        ),
        color: kindColor("plan_created"),
        emphasis: false,
        agentName: e.agentName,
      };
    }
    case "relationship_updated": {
      const other = str(p.otherName);
      const affinity = num(p.affinity);
      const delta = num(p.delta);
      const sign = delta !== null && delta >= 0 ? `+${delta}` : `${delta}`;
      const body =
        other !== null && delta !== null
          ? `${e.agentName ?? "?"} ♥ ${other} ${sign}` +
            (affinity !== null ? ` (now ${affinity})` : "")
          : e.text;
      return {
        text: clipLine(`${stamp} ${body}`, maxChars),
        color: kindColor("relationship_updated"),
        emphasis: false,
        agentName: e.agentName,
      };
    }
    case "gift_given": {
      const from = str(p.from);
      const to = str(p.to);
      const itemId = str(p.itemId);
      const body =
        from && to ? `${from} → ${to}: ${itemId ?? "a gift"}` : e.text;
      return {
        text: clipLine(`${stamp} 🎁 ${body}`, maxChars),
        color: kindColor("gift_given"),
        emphasis: true,
        agentName: e.agentName,
      };
    }
    case "conversation": {
      // Make the back-and-forth legible: render the turns[] transcript as a
      // readable A ⇄ B line, not the legacy two-liner. Falls back to the legacy
      // say/reply fields if turns[] is missing.
      const turns = Array.isArray(p.turns)
        ? (p.turns as unknown[]).filter(
            (t): t is { speaker: unknown; text: unknown } =>
              typeof t === "object" && t !== null,
          )
        : [];
      const pair = [str(p.speaker), str(p.listener)].filter((n): n is string => !!n);
      const head = pair.length === 2 ? `${pair[0]} ⇄ ${pair[1]}` : (e.agentName ?? "?");
      const quoted =
        turns.length > 0
          ? turns
              .map((t) => str(t.text))
              .filter((x): x is string => !!x)
              .map((x) => `“${x}”`)
              .join(" · ")
          : [str(p.say), str(p.reply)]
              .filter((x): x is string => !!x)
              .map((x) => `“${x}”`)
              .join(" · ");
      const body = quoted || e.text;
      return {
        text: clipLine(`${stamp} 💬 ${head}: ${body}`, maxChars),
        color: SPEECH_COLOR,
        emphasis: true,
        agentName: str(p.speaker) ?? e.agentName,
      };
    }
    case "llm_offline":
      return {
        text: clipLine(`${stamp} ⚠ LLM OFFLINE — ${e.text}`, maxChars),
        color: kindColor("llm_offline"),
        emphasis: true,
      };
    case "llm_recovered":
      return {
        text: clipLine(`${stamp} ✓ LLM recovered — live routing restored`, maxChars),
        color: kindColor("llm_recovered"),
        emphasis: true,
      };
    default:
      // open kind space: anything else renders via the v1 line formatter
      return {
        text: formatEventLine(e, maxChars),
        color: eventColor(e),
        emphasis: false,
        agentName: e.agentName,
      };
  }
}
