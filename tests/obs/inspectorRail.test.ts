/**
 * inspectorRail pure projections (B-7 SpaceCon inspector): the four trace nodes,
 * the honest Result/cost rules, the model strip, and the memory tag chips. These
 * are the load-bearing HONESTY guarantees — the Result node never fabricates an
 * outcome, and the model strip never invents a dollar cost.
 */
import { describe, expect, it } from "vitest";
import type { DecisionTraceEntry, MemoryEntry } from "@contracts/types";
import {
  actionText,
  memoryTagChip,
  modelStrip,
  orderMemoryStream,
  resultText,
  summarizeObservation,
  thoughtText,
  traceNodes,
} from "../../src/obs/inspectorRail";
import {
  brand400,
  brand500,
  cyan300,
  cyan500,
  ink300,
  ink500,
  obsTagFill,
  positive500,
  tintPlan,
  tintReflect,
  white,
} from "../../src/obs/theme";

function entry(over: Partial<DecisionTraceEntry> = {}): DecisionTraceEntry {
  return {
    turnId: "t1",
    day: 1,
    phase: "morning",
    observationJson: JSON.stringify({
      self: { pos: { x: 66, y: 49 }, energy: 80, gold: 120 },
      nearby: { agents: [{ name: "Bob" }], landmarks: [{ kind: "shop" }] },
    }),
    rawResponse: JSON.stringify({
      thought: "I'll till the soil",
      say: null,
      action: "TILL",
      target: { x: 66, y: 49 },
    }),
    parsedOk: true,
    action: "MOVE_TO (66,49)",
    model: "fable-5",
    latencyMs: 1200,
    tokensIn: 300,
    tokensOut: 40,
    ...over,
  };
}

function mem(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "Alice-m1",
    agentName: "Alice",
    type: "observation",
    text: "saw a parsnip",
    importance: 5,
    createdAt: { day: 1, phase: "morning" },
    lastAccess: { day: 1, phase: "morning" },
    ...over,
  };
}

describe("summarizeObservation", () => {
  it("summarizes pos/energy/gold/nearby instead of dumping JSON", () => {
    const s = summarizeObservation(entry().observationJson);
    expect(s).toContain("(66,49)");
    expect(s).toContain("E80");
    expect(s).toContain("120g");
    expect(s).toContain("Bob");
    expect(s.length).toBeLessThan(160);
  });
  it("honest dash on empty, defensive on malformed", () => {
    expect(summarizeObservation("")).toBe("—");
    expect(summarizeObservation("{not json")).not.toThrow;
    expect(typeof summarizeObservation("{not json")).toBe("string");
  });
});

describe("traceNodes — colors + honesty", () => {
  it("colors the four nodes per README §6", () => {
    const [obs, thought, action, result] = traceNodes({
      trace: [entry()],
      lastThought: "I'll till the soil",
      lastAction: { action: "TILL", ok: true },
    });
    expect([obs.label, thought.label, action.label, result.label]).toEqual([
      "OBSERVATION",
      "THOUGHT",
      "ACTION",
      "RESULT",
    ]);
    expect(obs.nodeColor).toBe(ink500.num);
    expect(thought.nodeColor).toBe(cyan500.num);
    expect(thought.labelColor).toBe(cyan300.num);
    expect(thought.italic).toBe(true);
    expect(action.nodeColor).toBe(brand500.num);
    expect(action.labelColor).toBe(brand400.num);
    expect(action.textColor).toBe(white.num);
    expect(result.nodeColor).toBe(positive500.num);
    expect(result.labelColor).toBe(positive500.num);
  });

  it("empty trace → honest dashes, never fabricated content", () => {
    const nodes = traceNodes({ trace: [], lastThought: null, lastAction: null });
    expect(nodes.map((n) => n.text)).toEqual(["—", "—", "—", "—"]);
  });
});

describe("thoughtText — newest only, honest dash otherwise", () => {
  it("uses lastThought when present", () => {
    expect(
      thoughtText({ trace: [entry()], lastThought: "harvest now", lastAction: null }),
    ).toBe("harvest now");
  });
  it("re-parses the newest raw response when no lastThought", () => {
    expect(
      thoughtText({ trace: [entry()], lastThought: null, lastAction: null }),
    ).toBe("I'll till the soil");
  });
  it("honest dash when no thought is recoverable", () => {
    const e = entry({ parsedOk: false, rawResponse: "garbage" });
    expect(thoughtText({ trace: [e], lastThought: null, lastAction: null })).toBe("—");
  });
});

describe("actionText", () => {
  it("reads the newest entry's action", () => {
    expect(actionText({ trace: [entry()], lastThought: null, lastAction: null })).toBe(
      "MOVE_TO (66,49)",
    );
  });
  it("honest dash when no action", () => {
    expect(
      actionText({ trace: [entry({ action: null })], lastThought: null, lastAction: null }),
    ).toBe("—");
  });
});

describe("resultText — the honest Result node", () => {
  it("uses the real lastAction outcome for the newest turn (ok)", () => {
    expect(
      resultText({ trace: [entry()], lastThought: null, lastAction: { action: "TILL", ok: true } }),
    ).toBe("ok");
  });
  it("surfaces a real rejection reason, not an invented outcome", () => {
    expect(
      resultText({
        trace: [entry()],
        lastThought: null,
        lastAction: { action: "TILL", ok: false, reason: "not adjacent" },
      }),
    ).toBe("rejected · not adjacent");
  });
  it("falls back to parse status (NOT a fabricated outcome) when no lastAction", () => {
    expect(
      resultText({ trace: [entry()], lastThought: null, lastAction: null }),
    ).toBe("parsed ok (outcome not tracked)");
    expect(
      resultText({ trace: [entry({ parsedOk: false })], lastThought: null, lastAction: null }),
    ).toBe("parse failure");
  });
});

describe("modelStrip — no fabricated cost", () => {
  it("mock collapses to a zero strip with no dollars", () => {
    const m = modelStrip({ model: null, latencyMs: null, tokensIn: null, tokensOut: null });
    expect(m.text).toBe("mock · 0 ms · 0 tok");
    expect(m.live).toBe(false);
    expect(m.text).not.toMatch(/\$/);
  });
  it('treats model "mock" as mock', () => {
    const m = modelStrip({ model: "mock", latencyMs: 5, tokensIn: 1, tokensOut: 1 });
    expect(m.text).toBe("mock · 0 ms · 0 tok");
    expect(m.live).toBe(false);
  });
  it("live shows model · latency · in/out tokens, never a dollar cost", () => {
    const m = modelStrip({ model: "fable-5", latencyMs: 1200, tokensIn: 300, tokensOut: 40 });
    expect(m.text).toBe("fable-5 · 1200 ms · 300/40 tok");
    expect(m.live).toBe(true);
    expect(m.text).not.toMatch(/\$/);
  });
});

describe("memoryTagChip", () => {
  it("OBS chip: ink300 on opaque obsTagFill", () => {
    const c = memoryTagChip("observation");
    expect(c.label).toBe("OBS");
    expect(c.color).toBe(ink300.num);
    expect(c.fill).toEqual({ color: obsTagFill.num, alpha: 1 });
  });
  it("REFLECT chip: cyan300 on the reflect tint", () => {
    const c = memoryTagChip("reflection");
    expect(c.label).toBe("REFLECT");
    expect(c.color).toBe(cyan300.num);
    expect(c.fill).toBe(tintReflect);
  });
  it("PLAN chip: brand400 on the plan tint", () => {
    const c = memoryTagChip("plan");
    expect(c.label).toBe("PLAN");
    expect(c.color).toBe(brand400.num);
    expect(c.fill).toBe(tintPlan);
  });
});

describe("orderMemoryStream", () => {
  it("newest-first then importance-desc, capped", () => {
    const entries = [
      mem({ id: "m1", text: "old low", importance: 2 }),
      mem({ id: "m2", text: "old high", importance: 9 }),
      mem({ id: "m3", text: "new mid", importance: 5 }),
    ];
    const out = orderMemoryStream(entries, 2);
    expect(out).toHaveLength(2);
    expect(out[0].importance).toBe(9);
    expect(out[1].importance).toBe(5); // newer than the importance-2 entry
  });
  it("empty in → empty out (honest)", () => {
    expect(orderMemoryStream([])).toEqual([]);
  });
  it("does not mutate the input array", () => {
    const entries = [mem({ id: "a", importance: 1 }), mem({ id: "b", importance: 9 })];
    const copy = entries.slice();
    orderMemoryStream(entries);
    expect(entries).toEqual(copy);
  });
});
