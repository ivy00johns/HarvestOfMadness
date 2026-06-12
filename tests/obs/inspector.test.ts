/**
 * Inspector pure functions: buildAgentCard projects an Agent fixture into the
 * contract AgentCardModel (newest trace entry feeds thought/say/model/latency/
 * tokens), and trace formatting truncates raw payloads explicitly.
 */
import { describe, expect, it } from "vitest";
import type { DecisionTraceEntry } from "@contracts/types";
import {
  buildAgentCard,
  formatTraceEntry,
  formatTraceSummary,
  truncate,
  TRACE_CAP,
  type InspectableAgent,
} from "../../src/obs/Inspector";

function traceEntry(partial: Partial<DecisionTraceEntry> = {}): DecisionTraceEntry {
  return {
    turnId: "Mira-7",
    day: 2,
    phase: "afternoon",
    observationJson: JSON.stringify({ self: { name: "Mira", energy: 80 } }),
    rawResponse: JSON.stringify({
      thought: "The parsnips need water before evening.",
      say: "Watering time!",
      action: "WATER",
      target: { x: 4, y: 7 },
    }),
    parsedOk: true,
    action: "WATER",
    model: "mock-farmer",
    latencyMs: 12,
    tokensIn: 350,
    tokensOut: 42,
    ...partial,
  };
}

function agentFixture(partial: Partial<InspectableAgent> = {}): InspectableAgent {
  return {
    name: "Mira",
    persona: "Anxious botanist who talks to crops",
    pos: { x: 4, y: 6 },
    energy: 77,
    gold: 130,
    inventory: [{ itemId: "seed:parsnip", qty: 3 }],
    goal: "earn 500g",
    lastAction: { action: "WATER", ok: true },
    fsm: "EXECUTING",
    decisionsToday: 9,
    decisionsTotal: 31,
    trace: [traceEntry()],
    ...partial,
  };
}

describe("buildAgentCard", () => {
  it("maps agent fields straight onto the contract card", () => {
    const card = buildAgentCard(agentFixture());
    expect(card.name).toBe("Mira");
    expect(card.persona).toBe("Anxious botanist who talks to crops");
    expect(card.gold).toBe(130);
    expect(card.energy).toBe(77);
    expect(card.goal).toBe("earn 500g");
    expect(card.lastAction).toEqual({ action: "WATER", ok: true });
    expect(card.fsm).toBe("EXECUTING");
    expect(card.decisionsToday).toBe(9);
    expect(card.decisionsTotal).toBe(31);
  });

  it("derives thought/say/model/latency/tokens from the NEWEST trace entry", () => {
    const newest = traceEntry({
      turnId: "Mira-9",
      rawResponse: JSON.stringify({
        thought: "Sell everything.",
        say: "To the shop!",
        action: "MOVE_TO",
        target: { x: 1, y: 1 },
      }),
      model: "llama-3.3-70b",
      latencyMs: 840,
      tokensIn: 512,
      tokensOut: 64,
    });
    const older = traceEntry({ turnId: "Mira-8", model: "mock-farmer" });
    const card = buildAgentCard(agentFixture({ trace: [newest, older] }));
    expect(card.lastThought).toBe("Sell everything.");
    expect(card.lastSay).toBe("To the shop!");
    expect(card.model).toBe("llama-3.3-70b");
    expect(card.latencyMs).toBe(840);
    expect(card.tokensIn).toBe(512);
    expect(card.tokensOut).toBe(64);
  });

  it("handles an empty trace with nulls (fresh agent)", () => {
    const card = buildAgentCard(agentFixture({ trace: [], lastAction: null }));
    expect(card.lastThought).toBeNull();
    expect(card.lastSay).toBeNull();
    expect(card.lastAction).toBeNull();
    expect(card.model).toBeNull();
    expect(card.latencyMs).toBeNull();
    expect(card.tokensIn).toBeNull();
    expect(card.tokensOut).toBeNull();
    expect(card.trace).toEqual([]);
  });

  it("yields null thought/say when the newest turn was a parse failure", () => {
    const failed = traceEntry({
      parsedOk: false,
      action: null,
      rawResponse: "I think I shall water the... oops no JSON here",
    });
    const card = buildAgentCard(agentFixture({ trace: [failed] }));
    expect(card.lastThought).toBeNull();
    expect(card.lastSay).toBeNull();
    expect(card.model).toBe("mock-farmer"); // metadata still surfaces
  });

  it("tolerates missing token counts (optional fields)", () => {
    const card = buildAgentCard(
      agentFixture({
        trace: [traceEntry({ tokensIn: undefined, tokensOut: undefined })],
      }),
    );
    expect(card.tokensIn).toBeNull();
    expect(card.tokensOut).toBeNull();
  });

  it("accepts agents-agent's Agent shape: object persona + direct thought/say", () => {
    const card = buildAgentCard(
      agentFixture({
        persona: { id: "mira", description: "Talks to crops" },
        lastThought: "Direct field wins",
        lastSay: null,
        trace: [traceEntry()], // rawResponse says something different
      }),
    );
    expect(card.persona).toBe("Talks to crops");
    expect(card.lastThought).toBe("Direct field wins");
    expect(card.lastSay).toBeNull();
  });

  it(`caps the card trace at ${TRACE_CAP} entries, newest-first preserved`, () => {
    const trace = Array.from({ length: 30 }, (_, i) =>
      traceEntry({ turnId: `Mira-${30 - i}` }),
    );
    const card = buildAgentCard(agentFixture({ trace }));
    expect(card.trace).toHaveLength(TRACE_CAP);
    expect(card.trace[0].turnId).toBe("Mira-30");
  });
});

describe("trace formatting", () => {
  it("formatTraceEntry includes header metadata, raw observation and response", () => {
    const out = formatTraceEntry(traceEntry());
    expect(out).toContain("[Mira-7] D2 afternoon");
    expect(out).toContain("mock-farmer");
    expect(out).toContain("12ms");
    expect(out).toContain("tok 350/42");
    expect(out).toContain("action WATER");
    expect(out).toContain("── observation ──");
    expect(out).toContain('"name":"Mira"');
    expect(out).toContain("── response ──");
    expect(out).toContain("The parsnips need water");
  });

  it("truncates oversized observation and response with explicit markers", () => {
    const big = traceEntry({
      observationJson: JSON.stringify({ blob: "x".repeat(2000) }),
      rawResponse: "y".repeat(2000),
    });
    const out = formatTraceEntry(big, {
      maxObservationChars: 100,
      maxResponseChars: 80,
    });
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("… (+");
    // verbatim prefix survives, nothing is reformatted
    expect(out).toContain('{"blob":"xxx');
    expect(out).toContain("yyy");
  });

  it("flags parse failures instead of pretending an action happened", () => {
    const out = formatTraceEntry(traceEntry({ parsedOk: false, action: null }));
    expect(out).toContain("PARSE FAILURE");
    expect(out).not.toContain("action WATER");
  });

  it("formatTraceSummary is a bounded one-liner", () => {
    const line = formatTraceSummary(traceEntry(), 56);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(56);
    expect(line).toContain("Mira-7");
  });

  it("truncate keeps short strings verbatim and marks hidden chars", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a".repeat(15), 10)).toBe(`${"a".repeat(10)}… (+5 chars)`);
  });
});
