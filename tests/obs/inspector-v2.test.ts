/**
 * Inspector v2 — optional AgentCardModel fields (planStep, relationships,
 * memoryCount/reflectionCount), the sprite-color passthrough (card ↔ sprite
 * visual link), relationship normalization across tolerated shapes, and the
 * affinity meter row formatting.
 */
import { describe, expect, it } from "vitest";
import {
  AFFINITY_BAR_SLOTS,
  RELATIONSHIP_TOP_N,
  buildAgentCard,
  formatAffinityRow,
  normalizeRelationships,
  topRelationships,
  type InspectableAgent,
} from "../../src/obs/Inspector";

function agentFixture(partial: Partial<InspectableAgent> = {}): InspectableAgent {
  return {
    name: "Dora",
    persona: "Methodical optimizer",
    pos: { x: 3, y: 5 },
    energy: 90,
    gold: 200,
    inventory: [],
    goal: null,
    lastAction: null,
    fsm: "IDLE",
    decisionsToday: 0,
    decisionsTotal: 0,
    trace: [],
    ...partial,
  };
}

describe("v2 optional card fields", () => {
  it("omits every v2 field for a v1-shaped agent (graceful degradation)", () => {
    const card = buildAgentCard(agentFixture());
    expect(card.planStep).toBeUndefined();
    expect(card.relationships).toBeUndefined();
    expect(card.memoryCount).toBeUndefined();
    expect(card.reflectionCount).toBeUndefined();
    expect(card.color).toBeUndefined();
  });

  it("passes planStep, counts, and the sprite color through when present", () => {
    const card = buildAgentCard(
      agentFixture({
        color: 0xff5252,
        planStep: "water the east plot",
        memoryCount: 42,
        reflectionCount: 3,
      }),
    );
    expect(card.color).toBe(0xff5252);
    expect(card.planStep).toBe("water the east plot");
    expect(card.memoryCount).toBe(42);
    expect(card.reflectionCount).toBe(3);
  });

  it("normalizes contract-shaped relationship arrays onto the card", () => {
    const card = buildAgentCard(
      agentFixture({
        relationships: [
          { name: "Sage", affinity: 24, summary: "helped fix my fence" },
        ],
      }),
    );
    expect(card.relationships).toEqual([
      { name: "Sage", affinity: 24, summary: "helped fix my fence" },
    ]);
  });

  it("accepts RelationshipSummary-shaped rows (otherName) too", () => {
    const card = buildAgentCard(
      agentFixture({
        relationshipSummaries: [
          { agentName: "Dora", otherName: "Rusty", affinity: -15.6, summary: "trampled my plot" },
        ],
      }),
    );
    expect(card.relationships).toEqual([
      { name: "Rusty", affinity: -16, summary: "trampled my plot" },
    ]);
  });

  it("ignores the v1 Record<string, number> TALK_TO counter (not affinity)", () => {
    const card = buildAgentCard(
      agentFixture({ relationships: { Sage: 3, Rusty: 1 } }),
    );
    expect(card.relationships).toBeUndefined();
  });
});

describe("normalizeRelationships defensiveness", () => {
  it("skips malformed rows and clamps affinity to [-100, 100]", () => {
    const rows = normalizeRelationships([
      { name: "Sage", affinity: 250 },
      { name: "Rusty", affinity: -999, summary: 7 }, // non-string summary → ""
      { name: "NoAffinity" },
      { affinity: 10 }, // no name
      "garbage",
      null,
      { name: "Edge", affinity: Number.NaN },
    ]);
    expect(rows).toEqual([
      { name: "Sage", affinity: 100, summary: "" },
      { name: "Rusty", affinity: -100, summary: "" },
    ]);
  });

  it("returns [] for any non-array input", () => {
    expect(normalizeRelationships(undefined)).toEqual([]);
    expect(normalizeRelationships(null)).toEqual([]);
    expect(normalizeRelationships({ Sage: 3 })).toEqual([]);
    expect(normalizeRelationships("Sage")).toEqual([]);
  });
});

describe("topRelationships", () => {
  it(`keeps the strongest |affinity| rows, capped at ${RELATIONSHIP_TOP_N}`, () => {
    const rows = [
      { name: "A", affinity: 5 },
      { name: "B", affinity: -80 },
      { name: "C", affinity: 30 },
      { name: "D", affinity: 12 },
    ];
    const top = topRelationships(rows);
    expect(top.map((r) => r.name)).toEqual(["B", "C", "D"]);
  });

  it("does not mutate the input order", () => {
    const rows = [
      { name: "A", affinity: 1 },
      { name: "B", affinity: 99 },
    ];
    topRelationships(rows);
    expect(rows[0].name).toBe("A");
  });
});

describe("formatAffinityRow", () => {
  it("renders name + signed bar + signed number", () => {
    const row = formatAffinityRow("Sage", 24);
    expect(row).toMatch(/^Sage\s+█░░░░ \+24$/);
    const neg = formatAffinityRow("Rusty", -80);
    expect(neg).toContain("████░");
    expect(neg).toContain("-80");
  });

  it("any nonzero affinity lights at least one slot; zero lights none", () => {
    expect(formatAffinityRow("X", 1)).toContain("█");
    expect(formatAffinityRow("X", 0)).toContain("░".repeat(AFFINITY_BAR_SLOTS));
    expect(formatAffinityRow("X", 0)).not.toContain("█");
  });

  it("fills every slot at |affinity| 100 and clips long names", () => {
    const row = formatAffinityRow("Maximiliana", 100);
    expect(row).toContain("█".repeat(AFFINITY_BAR_SLOTS));
    expect(row).toContain("Maximili…");
    expect(row).not.toContain("Maximiliana");
  });
});
