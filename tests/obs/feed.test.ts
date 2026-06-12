/**
 * FeedModel — v2 spectator feed: decision-turn collapsing (one line per
 * turnId), "— Day N —" separators, suppressed kinds (memory_written /
 * agent_emote), the relationship-delta threshold, speech emphasis, and the
 * contract rule that unknown EventKinds MUST be tolerated.
 */
import { describe, expect, it } from "vitest";
import type { EventBus, WorldEvent } from "@contracts/types";
import {
  FEED_DISPLAY_CAP,
  FeedModel,
  RELATIONSHIP_DELTA_MIN,
  SUPPRESSED_KINDS,
  TURN_CHAIN_KINDS,
  formatDaySeparator,
  formatFeedItem,
  formatTurnLine,
  type TurnFeedItem,
} from "../../src/obs/Feed";
import { DEFAULT_EVENT_COLOR, kindColor } from "../../src/obs/EventLog";

let seq = 0;

function ev(partial: Partial<WorldEvent> = {}): WorldEvent {
  seq += 1;
  return {
    seq,
    day: 1,
    phase: "morning",
    kind: "agent_moved",
    text: `event ${seq}`,
    ts: 1_000_000 + seq,
    ...partial,
  };
}

/** Emit the full 4-event decision chain for one turnId. */
function emitTurn(
  feed: FeedModel,
  agentName: string,
  turnId: string,
  opts: { action?: string; ok?: boolean; reason?: string; model?: string } = {},
): void {
  const action = opts.action ?? "WATER";
  feed.push(ev({ kind: "turn_start", agentName, turnId, text: `${agentName} is deciding` }));
  feed.push(
    ev({
      kind: "llm_call",
      agentName,
      turnId,
      payload: { model: opts.model ?? "mock-farmer", latencyMs: 12 },
    }),
  );
  feed.push(ev({ kind: "action_chosen", agentName, turnId, payload: { action } }));
  feed.push(
    ev({
      kind: "action_resolved",
      agentName,
      turnId,
      payload: {
        action,
        ok: opts.ok ?? true,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    }),
  );
}

describe("turn collapsing", () => {
  it("collapses the 4-event decision chain into ONE feed item", () => {
    const feed = new FeedModel();
    emitTurn(feed, "Dora", "Dora-1");
    expect(feed.size()).toBe(1);
    const item = feed.list()[0];
    expect(item.type).toBe("turn");
    const turn = item as TurnFeedItem;
    expect(turn.turnId).toBe("Dora-1");
    expect(turn.action).toBe("WATER");
    expect(turn.ok).toBe(true);
    expect(turn.model).toBe("mock-farmer");
    expect(turn.latencyMs).toBe(12);
  });

  it("keeps interleaved turns from different agents as separate items", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "turn_start", agentName: "Dora", turnId: "Dora-1" }));
    feed.push(ev({ kind: "turn_start", agentName: "Rusty", turnId: "Rusty-1" }));
    feed.push(
      ev({
        kind: "action_resolved",
        agentName: "Dora",
        turnId: "Dora-1",
        payload: { action: "TILL", ok: true },
      }),
    );
    expect(feed.size()).toBe(2);
    const [newest, oldest] = feed.list() as TurnFeedItem[];
    expect(newest.turnId).toBe("Rusty-1");
    expect(newest.ok).toBeNull(); // still in flight
    expect(oldest.turnId).toBe("Dora-1");
    expect(oldest.ok).toBe(true);
  });

  it("renders pending, resolved-ok, and rejected states distinctly", () => {
    const pending: TurnFeedItem = {
      type: "turn",
      turnId: "Dora-1",
      agentName: "Dora",
      day: 2,
      phase: "afternoon",
      model: null,
      latencyMs: null,
      action: null,
      ok: null,
      reason: null,
      parseFailed: false,
      error: null,
    };
    expect(formatTurnLine(pending, 68)).toContain("deciding…");

    const okLine = formatTurnLine(
      { ...pending, action: "WATER", ok: true, model: "mock-farmer", latencyMs: 9 },
      68,
    );
    expect(okLine).toContain("WATER ✓");
    expect(okLine).toContain("mock-farmer 9ms");
    expect(okLine).toContain("D2·aft Dora");

    const badLine = formatTurnLine(
      { ...pending, action: "TILL", ok: false, reason: "not adjacent" },
      68,
    );
    expect(badLine).toContain("TILL ✗ not adjacent");

    const view = formatFeedItem({ ...pending, action: "TILL", ok: false, reason: "x" });
    expect(view.agentName).toBe("Dora"); // clickable → opens the trace panel
  });

  it("marks parse failures on the collapsed line", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "turn_start", agentName: "Dora", turnId: "Dora-2" }));
    feed.push(ev({ kind: "parse_failure", agentName: "Dora", turnId: "Dora-2" }));
    const turn = feed.list()[0] as TurnFeedItem;
    expect(turn.parseFailed).toBe(true);
    expect(formatFeedItem(turn).text).toContain("parse failure");
  });

  it("chain events without a turnId degrade to standalone lines (defensive)", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "turn_start", agentName: "Dora" })); // no turnId
    expect(feed.size()).toBe(1);
    expect(feed.list()[0].type).toBe("event");
  });

  it("exports the chain-kind set the contract documents", () => {
    for (const k of ["turn_start", "llm_call", "action_chosen", "action_resolved"]) {
      expect(TURN_CHAIN_KINDS.has(k)).toBe(true);
    }
  });
});

describe("day separators", () => {
  it("inserts a visually distinct separator on day_advanced", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "day_advanced", day: 2, payload: { day: 2 } }));
    expect(feed.size()).toBe(1);
    const item = feed.list()[0];
    expect(item.type).toBe("separator");
    const view = formatFeedItem(item);
    expect(view.text).toContain("Day 2");
    expect(view.emphasis).toBe(true);
    expect(formatDaySeparator(2)).toMatch(/─+\s+Day 2\s+─+/);
  });

  it("dedupes separators for the same day (multiple sleepers)", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "day_advanced", day: 2, payload: { day: 2 } }));
    feed.push(ev({ kind: "day_advanced", day: 2, payload: { day: 2 } }));
    feed.push(ev({ kind: "day_advanced", day: 3, payload: { day: 3 } }));
    const separators = feed.list().filter((i) => i.type === "separator");
    expect(separators).toHaveLength(2);
  });

  it("falls back to the event's day when the payload lacks one", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "day_advanced", day: 5 }));
    expect(feed.list()[0]).toMatchObject({ type: "separator", day: 5 });
  });
});

describe("suppressed kinds", () => {
  it("memory_written never renders but feeds the M: counter", () => {
    const feed = new FeedModel();
    for (let i = 0; i < 42; i++) {
      feed.push(ev({ kind: "memory_written", agentName: "Dora" }));
    }
    feed.push(ev({ kind: "memory_written", agentName: "Rusty" }));
    expect(feed.size()).toBe(0);
    expect(feed.memoryCount("Dora")).toBe(42);
    expect(feed.memoryCount("Rusty")).toBe(1);
    expect(feed.memoryCount("Sage")).toBe(0);
  });

  it("agent_emote is feed-suppressed (cards/world show it)", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "agent_emote", agentName: "Dora", payload: { emotion: "happy" } }));
    expect(feed.size()).toBe(0);
    expect(SUPPRESSED_KINDS.has("agent_emote")).toBe(true);
    expect(SUPPRESSED_KINDS.has("memory_written")).toBe(true);
  });

  it("reflection events render AND increment the R: counter", () => {
    const feed = new FeedModel();
    feed.push(
      ev({ kind: "reflection", agentName: "Dora", text: "I work too much" }),
    );
    expect(feed.size()).toBe(1);
    expect(feed.reflectionCount("Dora")).toBe(1);
    const view = formatFeedItem(feed.list()[0]);
    expect(view.text).toContain("💭");
    expect(view.text).toContain("I work too much");
    expect(view.color).toBe(kindColor("reflection"));
    expect(view.color).not.toBe(DEFAULT_EVENT_COLOR);
  });
});

describe("relationship-delta threshold", () => {
  it(`renders relationship_updated only when |delta| ≥ ${RELATIONSHIP_DELTA_MIN}`, () => {
    const feed = new FeedModel();
    feed.push(
      ev({
        kind: "relationship_updated",
        agentName: "Dora",
        payload: { otherName: "Sage", affinity: 4, delta: 2 },
      }),
    );
    expect(feed.size()).toBe(0); // small TALK_TO bump — flood guard
    feed.push(
      ev({
        kind: "relationship_updated",
        agentName: "Dora",
        payload: { otherName: "Sage", affinity: 14, delta: 10 },
      }),
    );
    feed.push(
      ev({
        kind: "relationship_updated",
        agentName: "Rusty",
        payload: { otherName: "Sage", affinity: -20, delta: -12 },
      }),
    );
    expect(feed.size()).toBe(2);
    const [neg, pos] = feed.list().map((i) => formatFeedItem(i));
    expect(pos.text).toContain("Dora ♥ Sage +10");
    expect(pos.text).toContain("(now 14)");
    expect(neg.text).toContain("-12");
  });

  it("drops relationship_updated without a numeric delta (defensive)", () => {
    const feed = new FeedModel();
    feed.push(ev({ kind: "relationship_updated", payload: { otherName: "Sage" } }));
    expect(feed.size()).toBe(0);
  });
});

describe("v2 line formatting", () => {
  it("agent_speech renders speaker + quoted utterance, emphasized", () => {
    const view = formatFeedItem({
      type: "event",
      event: ev({
        kind: "agent_speech",
        agentName: "Sage",
        day: 3,
        phase: "evening",
        payload: { say: "Lovely crops, Dora!" },
      }),
    });
    expect(view.text).toContain("D3·eve");
    expect(view.text).toContain("Sage:");
    expect(view.text).toContain("“Lovely crops, Dora!”");
    expect(view.emphasis).toBe(true);
  });

  it("plan_created renders day + abbreviated goals on one line", () => {
    const view = formatFeedItem(
      {
        type: "event",
        event: ev({
          kind: "plan_created",
          agentName: "Dora",
          payload: {
            day: 3,
            steps: ["water east plot", "harvest parsnips", "sell at shop", "sleep early"],
          },
        }),
      },
      120,
    );
    expect(view.text).toContain("📋");
    expect(view.text).toContain("D3 plan:");
    expect(view.text).toContain("water east plot → harvest parsnips");
    expect(view.text).not.toContain("\n");
  });

  it("gift_given renders from → to with the item", () => {
    const view = formatFeedItem({
      type: "event",
      event: ev({
        kind: "gift_given",
        agentName: "Dora",
        payload: { from: "Dora", to: "Sage", itemId: "crop:parsnip" },
      }),
    });
    expect(view.text).toContain("🎁");
    expect(view.text).toContain("Dora → Sage: crop:parsnip");
  });

  it("llm_offline / llm_recovered lines are emphasized", () => {
    const off = formatFeedItem({
      type: "event",
      event: ev({ kind: "llm_offline", text: "proxy unreachable" }),
    });
    expect(off.text).toContain("LLM OFFLINE");
    expect(off.emphasis).toBe(true);
    const back = formatFeedItem({
      type: "event",
      event: ev({ kind: "llm_recovered" }),
    });
    expect(back.text.toLowerCase()).toContain("recovered");
  });
});

describe("unknown-kind tolerance (open EventKind union)", () => {
  it("renders unknown kinds with the default color, never throws", () => {
    const feed = new FeedModel();
    const weird = ev({ kind: "totally_new_kind_v3", agentName: "Dora", text: "???" });
    expect(() => feed.push(weird)).not.toThrow();
    expect(feed.size()).toBe(1);
    const view = formatFeedItem(feed.list()[0]);
    expect(view.color).toBe(DEFAULT_EVENT_COLOR);
    expect(view.text).toContain("???");
  });
});

describe("cap + bus attachment", () => {
  it("caps the display list and forgets evicted turn ids", () => {
    const feed = new FeedModel(5);
    for (let i = 1; i <= 8; i++) emitTurn(feed, "Dora", `Dora-${i}`);
    expect(feed.size()).toBe(5);
    const ids = (feed.list() as TurnFeedItem[]).map((t) => t.turnId);
    expect(ids).toEqual(["Dora-8", "Dora-7", "Dora-6", "Dora-5", "Dora-4"]);
    // a late chain event for an evicted turn re-creates rather than crashes
    expect(() =>
      feed.push(
        ev({
          kind: "action_resolved",
          agentName: "Dora",
          turnId: "Dora-1",
          payload: { action: "WAIT", ok: true },
        }),
      ),
    ).not.toThrow();
  });

  it("defaults to the documented display cap", () => {
    expect(FEED_DISPLAY_CAP).toBe(100);
  });

  it("attach() seeds from bus.recent() and follows live events", () => {
    const buffer: WorldEvent[] = [];
    const listeners = new Set<(e: WorldEvent) => void>();
    const bus: EventBus = {
      emit(e) {
        const full = { ...e, seq: ++seq, ts: Date.now() } as WorldEvent;
        buffer.push(full);
        for (const cb of listeners) cb(full);
      },
      on(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      recent(limit = 1000) {
        return buffer.slice(-limit);
      },
    };
    bus.emit({ day: 1, phase: "morning", kind: "economy", text: "seeded" });
    const feed = new FeedModel();
    const unsub = feed.attach(bus);
    expect(feed.size()).toBe(1);
    bus.emit({ day: 1, phase: "morning", kind: "economy", text: "live" });
    expect(feed.size()).toBe(2);
    unsub();
    bus.emit({ day: 1, phase: "morning", kind: "economy", text: "after" });
    expect(feed.size()).toBe(2);
  });
});
