/**
 * v2 mock cognition counterparts — rateImportanceMock (rule 9 heuristic),
 * mockReflection (rule 11 mock path), mockDailyPlan (rule 12 mock path),
 * and mockRouter robustness against v2 observation fields + tier.
 */
import { describe, expect, it } from "vitest";
import type { Observation } from "@contracts/types";
import { mockDailyPlan, mockReflection, mockRouter, rateImportanceMock } from "../../src/llm/mock";
import { buildUserPrompt } from "../../src/llm/prompts";

describe("rateImportanceMock — rule 9 heuristic", () => {
  it("rates gifts 7", () => {
    expect(rateImportanceMock("Rusty gave me a gift: crop:parsnip")).toBe(7);
    expect(rateImportanceMock("I received a parsnip from Mona")).toBe(7);
  });

  it("rates harvest failures 7", () => {
    expect(rateImportanceMock("tried to harvest but it failed: crop not ready")).toBe(7);
  });

  it("rates conversations 5", () => {
    expect(rateImportanceMock("talked with Rusty about the weather")).toBe(5);
    expect(rateImportanceMock('Mona said "hello there"')).toBe(5);
  });

  it("rates routine farm actions 2", () => {
    expect(rateImportanceMock("watered the parsnip at (4,5)")).toBe(2);
    expect(rateImportanceMock("tilled the ground at (3,3)")).toBe(2);
    expect(rateImportanceMock("planted seed:parsnip")).toBe(2);
    expect(rateImportanceMock("sold 3 crop:parsnip at the shop")).toBe(2);
  });

  it("is deterministic, in 1..10, and never throws on weird input", () => {
    for (const text of ["", "a quiet evening", "!!!", "x".repeat(5000)]) {
      const a = rateImportanceMock(text);
      const b = rateImportanceMock(text);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(10);
    }
  });
});

describe("mockReflection — rule 11 mock path", () => {
  const memories = [
    { id: "Dora-m1", text: "watered the parsnip" },
    { id: "Dora-m2", text: "Rusty gave me a gift" },
    { id: "Dora-m3", text: "sold 3 parsnips" },
  ];

  it("returns one templated insight text citing source ids", () => {
    const r = mockReflection("Dora", memories);
    expect(r.text).toContain("Dora");
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.sourceIds).toEqual(["Dora-m1", "Dora-m2", "Dora-m3"]);
  });

  it("caps citations at 5 like the live insights prompt", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, text: `memory ${i}` }));
    expect(mockReflection("Dora", many).sourceIds).toHaveLength(5);
  });

  it("is deterministic and survives an empty memory list", () => {
    expect(mockReflection("Dora", memories)).toEqual(mockReflection("Dora", memories));
    const empty = mockReflection("Dora", []);
    expect(empty.sourceIds).toEqual([]);
    expect(empty.text).toContain("Dora");
  });
});

describe("mockDailyPlan — rule 12 mock path", () => {
  it("produces exactly 4 steps, one per phase in order, ending in bed", () => {
    const plan = mockDailyPlan("Diligent Dora — methodical optimizer", 3);
    expect(plan.steps.map((s) => s.phase)).toEqual(["morning", "afternoon", "evening", "night"]);
    expect(plan.steps.every((s) => s.done === false)).toBe(true);
    expect(plan.steps.every((s) => s.goal.length > 0)).toBe(true);
    expect(plan.steps[3].targetLandmark).toBe("bed");
    expect(plan.steps[3].goal).toContain("sleep");
  });

  it("rawText is parseable JSON shaped {steps:[...4]} (mirrors the live prompt contract)", () => {
    const plan = mockDailyPlan("Reckless Rusty", 1);
    const parsed = JSON.parse(plan.rawText) as { steps: Array<{ phase: string; goal: string }> };
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.steps[0].phase).toBe("morning");
  });

  it("is deterministic and persona-flavored", () => {
    expect(mockDailyPlan("Social Sam", 2)).toEqual(mockDailyPlan("Social Sam", 2));
    const social = mockDailyPlan("Social Sam — loves a chat", 2);
    const diligent = mockDailyPlan("Diligent Dora", 2);
    expect(social.steps[2].goal).not.toBe(diligent.steps[2].goal);
    // evening step always heads to the shop either way
    expect(social.steps[2].targetLandmark).toBe("shop");
  });

  it("never throws on empty persona", () => {
    expect(mockDailyPlan("", 1).steps).toHaveLength(4);
  });
});

describe("mockRouter — v2 observation robustness", () => {
  function v2Obs(): Observation {
    return {
      self: {
        name: "Dora",
        persona: "Diligent Dora",
        role: "farmer",
        pos: { x: 5, y: 5 },
        energy: 80,
        gold: 100,
        inventory: [{ itemId: "seed:parsnip", qty: 2 }],
        goal: null,
        currentPlanStep: "water the east plot",
        relationships: [{ name: "Rusty", affinity: 12 }],
      },
      time: { day: 2, phase: "morning" },
      nearby: {
        tiles: [{ x: 5, y: 4, type: "tilled" }],
        agents: [{ name: "Rusty", pos: { x: 6, y: 5 }, lastSeenDoing: "tilling" }],
        landmarks: [
          { kind: "bed", pos: { x: 2, y: 2 } },
          { kind: "shop", pos: { x: 10, y: 5 } },
        ],
      },
      lastAction: null,
      availableActions: [
        "MOVE_TO",
        "TILL",
        "PLANT",
        "WATER",
        "HARVEST",
        "BUY",
        "SELL",
        "TALK_TO",
        "GIVE_GIFT",
        "EMOTE",
        "SLEEP",
        "WAIT",
      ],
      economy: { sells: {}, buys: {} },
      memories: [{ text: "Rusty gave me a gift", type: "observation", importance: 7 }],
    };
  }

  it("does not crash on v2 fields (memories/planStep/relationships/new actions) and returns a valid action", async () => {
    const obs = v2Obs();
    const res = await mockRouter({
      agentId: "Dora",
      system: "test",
      user: buildUserPrompt(obs),
    });
    expect(res.error).toBeUndefined();
    expect(res.model).toBe("mock");
    expect(res.parsed).toBeDefined();
    expect(res.parsed!.action).toBeTruthy();
  });

  it("ignores the tier field (mock is tier-free)", async () => {
    const obs = v2Obs();
    const base = { agentId: "Dora", system: "test", user: buildUserPrompt(obs) };
    const fast = await mockRouter({ ...base, tier: "fast" });
    const none = await mockRouter(base);
    expect(fast.parsed).toEqual(none.parsed);
    expect(fast.model).toBe("mock");
  });
});
