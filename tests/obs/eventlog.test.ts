/**
 * EventLog list discipline: display cap, newest-first ordering, bus
 * attach/seed/unsubscribe, and the contract rule that consumers MUST
 * tolerate unknown EventKind strings.
 */
import { describe, expect, it } from "vitest";
import type { EventBus, WorldEvent } from "@contracts/types";
import {
  DEFAULT_EVENT_COLOR,
  EVENT_LOG_DISPLAY_CAP,
  EventLog,
  eventColor,
  formatEventLine,
  kindColor,
  toCssColor,
} from "../../src/obs/EventLog";

let seq = 0;

function ev(partial: Partial<WorldEvent> = {}): WorldEvent {
  seq += 1;
  return {
    seq,
    day: 1,
    phase: "morning",
    kind: "action_resolved",
    text: `event ${seq}`,
    ts: 1_000_000 + seq,
    ...partial,
  };
}

/** Minimal in-memory EventBus (contract shape: recent() is newest-LAST). */
function fakeBus(seedCount = 0): EventBus & { listeners: Set<(e: WorldEvent) => void> } {
  const buffer: WorldEvent[] = [];
  const listeners = new Set<(e: WorldEvent) => void>();
  const bus = {
    listeners,
    emit(e: Omit<WorldEvent, "seq" | "ts">): void {
      const full = { ...e, seq: ++seq, ts: Date.now() } as WorldEvent;
      buffer.push(full);
      for (const cb of listeners) cb(full);
    },
    on(cb: (e: WorldEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    recent(limit = 1000): WorldEvent[] {
      return buffer.slice(-limit);
    },
  };
  for (let i = 0; i < seedCount; i++) {
    bus.emit({ day: 1, phase: "morning", kind: "agent_moved", text: `seed ${i}` });
  }
  return bus;
}

describe("EventLog", () => {
  it("keeps newest-first order", () => {
    const log = new EventLog();
    const a = ev({ text: "first" });
    const b = ev({ text: "second" });
    const c = ev({ text: "third" });
    log.push(a);
    log.push(b);
    log.push(c);
    expect(log.list().map((e) => e.text)).toEqual(["third", "second", "first"]);
  });

  it("caps the display list at 100 by default", () => {
    const log = new EventLog();
    for (let i = 0; i < 150; i++) log.push(ev());
    expect(log.size()).toBe(EVENT_LOG_DISPLAY_CAP);
    expect(log.size()).toBe(100);
  });

  it("honors a custom cap and drops the oldest entries", () => {
    const log = new EventLog(3);
    for (let i = 1; i <= 5; i++) log.push(ev({ text: `e${i}` }));
    expect(log.list().map((e) => e.text)).toEqual(["e5", "e4", "e3"]);
  });

  it("list(limit) returns at most limit newest entries", () => {
    const log = new EventLog();
    for (let i = 1; i <= 20; i++) log.push(ev({ text: `e${i}` }));
    const top = log.list(12);
    expect(top).toHaveLength(12);
    expect(top[0].text).toBe("e20");
  });

  it("tolerates unknown event kinds (open EventKind space)", () => {
    const log = new EventLog();
    const weird = ev({ kind: "totally_unknown_kind_v9", text: "mystery" });
    expect(() => log.push(weird)).not.toThrow();
    expect(() => formatEventLine(weird)).not.toThrow();
    expect(kindColor("totally_unknown_kind_v9")).toBe(DEFAULT_EVENT_COLOR);
    expect(eventColor(weird)).toBe(DEFAULT_EVENT_COLOR);
  });

  it("attach() seeds from bus.recent() into newest-first order", () => {
    const bus = fakeBus();
    bus.emit({ day: 1, phase: "morning", kind: "turn_start", text: "old" });
    bus.emit({ day: 1, phase: "morning", kind: "turn_start", text: "new" });
    const log = new EventLog();
    log.attach(bus);
    expect(log.list().map((e) => e.text)).toEqual(["new", "old"]);
  });

  it("attach() follows live events and unsubscribe stops the flow", () => {
    const bus = fakeBus();
    const log = new EventLog();
    const unsub = log.attach(bus);
    bus.emit({ day: 2, phase: "evening", kind: "economy", text: "sold parsnip" });
    expect(log.list()[0].text).toBe("sold parsnip");
    unsub();
    bus.emit({ day: 2, phase: "evening", kind: "economy", text: "after unsub" });
    expect(log.list()[0].text).toBe("sold parsnip");
    expect(bus.listeners.size).toBe(0);
  });
});

describe("formatting helpers", () => {
  it("formats one-line feed text with day/phase stamp and agent name", () => {
    const line = formatEventLine(
      ev({ day: 3, phase: "afternoon", agentName: "Mira", text: "watered (4,7)" }),
    );
    expect(line).toBe("D3·aft Mira: watered (4,7)");
  });

  it("truncates long lines and flattens whitespace", () => {
    const line = formatEventLine(ev({ text: `multi\nline ${"x".repeat(200)}` }), 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("\n");
  });

  it("colors known kinds distinctly and failures as failure-red", () => {
    expect(kindColor("parse_failure")).not.toBe(kindColor("action_resolved"));
    const rejected = ev({ kind: "action_resolved", payload: { ok: false } });
    expect(eventColor(rejected)).toBe(kindColor("parse_failure"));
    expect(toCssColor(0x00ff00)).toBe("#00ff00");
    expect(toCssColor(0x000012)).toBe("#000012");
  });
});
