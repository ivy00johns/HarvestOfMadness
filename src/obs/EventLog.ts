/**
 * EventLog — spectator-facing view over the EventBus (§8).
 *
 * Pure logic, no Phaser: maintains a newest-first render list capped at
 * EVENT_LOG_DISPLAY_CAP (the bus itself rings at 1000) plus the formatting
 * helpers (kind → color, one-line feed text) used by UIScene.
 *
 * Contract rule: EventKind is an open string space — unknown kinds MUST be
 * tolerated (rendered with the default color, never thrown on).
 */
import type { EventBus, EventKind, WorldEvent } from "@contracts/types";

/** UI render cap; the bus ring buffer (cap 1000) is the real history. */
export const EVENT_LOG_DISPLAY_CAP = 100;

/** Known kind → color. Unknown kinds fall back to DEFAULT_EVENT_COLOR. */
const KIND_COLORS: Record<string, number> = {
  turn_start: 0x6f7682,
  llm_call: 0x7aa2f7,
  action_chosen: 0x73daca,
  action_resolved: 0x9ece6a,
  parse_failure: 0xf7768e,
  agent_speech: 0xe0af68,
  agent_moved: 0x565f89,
  economy: 0xffd700,
  day_advanced: 0xbb9af7,
  budget_reached: 0xff5555,
};

export const DEFAULT_EVENT_COLOR = 0x9aa0aa;
export const FAILURE_EVENT_COLOR = 0xf7768e;

export function kindColor(kind: EventKind): number {
  return KIND_COLORS[kind] ?? DEFAULT_EVENT_COLOR;
}

/** Like kindColor, but rejected action_resolved events read as failures. */
export function eventColor(e: WorldEvent): number {
  if (e.kind === "action_resolved" && e.payload?.ok === false) {
    return FAILURE_EVENT_COLOR;
  }
  return kindColor(e.kind);
}

/** 0xRRGGBB → "#rrggbb" (Phaser text color strings). */
export function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

const PHASE_ABBREV: Record<string, string> = {
  morning: "mor",
  afternoon: "aft",
  evening: "eve",
  night: "ngt",
};

/** One feed line: "D2·aft Mira: watered (3,7)" — truncated, single line. */
export function formatEventLine(e: WorldEvent, maxChars = 64): string {
  const stamp = `D${e.day}·${PHASE_ABBREV[e.phase] ?? e.phase}`;
  const who = e.agentName ? `${e.agentName}: ` : "";
  const text = e.text.replace(/\s+/g, " ").trim();
  const line = `${stamp} ${who}${text}`;
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/**
 * Newest-first display list. attach() seeds from the bus ring buffer and
 * subscribes for live events; returns the unsubscribe function.
 */
export class EventLog {
  private events: WorldEvent[] = [];

  constructor(private readonly cap: number = EVENT_LOG_DISPLAY_CAP) {}

  /** Seed from bus.recent() (newest-last) then follow live events. */
  attach(bus: EventBus): () => void {
    for (const e of bus.recent(this.cap)) this.push(e);
    return bus.on((e) => this.push(e));
  }

  /** Insert newest-first; trims past the cap. Unknown kinds welcome. */
  push(e: WorldEvent): void {
    this.events.unshift(e);
    if (this.events.length > this.cap) this.events.length = this.cap;
  }

  /** Newest-first snapshot (copy), optionally limited. */
  list(limit?: number): WorldEvent[] {
    return limit === undefined
      ? this.events.slice()
      : this.events.slice(0, Math.max(0, limit));
  }

  size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}
