/**
 * v2 prompt builders (cognition prompts + decision-prompt extensions).
 * The v1 assertions live in tests/llm/prompts.test.ts and must keep passing.
 */
import { describe, expect, it } from "vitest";
import type { Landmark, Observation } from "@contracts/types";
import {
  buildDailyPlanPrompt,
  buildImportancePrompt,
  buildReflectionInsightsPrompt,
  buildReflectionQuestionsPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "../../src/llm/prompts";

const CLOSING_LINE = "Respond with ONLY one JSON object — no prose, no fences.";

function baseObs(): Observation {
  return {
    self: {
      name: "Dora",
      persona: "Diligent Dora",
      role: "farmer",
      pos: { x: 5, y: 5 },
      energy: 80,
      gold: 100,
      inventory: [],
      goal: null,
    },
    time: { day: 3, phase: "morning" },
    nearby: { tiles: [], agents: [], landmarks: [] },
    lastAction: null,
    availableActions: ["WAIT"],
    economy: { sells: {}, buys: {} },
  };
}

describe("buildSystemPrompt — v2 actions + emotion", () => {
  const prompt = buildSystemPrompt("Diligent Dora");

  it("includes GIVE_GIFT and EMOTE in the action enum while keeping the v1 enum substring", () => {
    expect(prompt).toContain(
      '"MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"|"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT"',
    );
    expect(prompt).toContain('"GIVE_GIFT"');
    expect(prompt).toContain('"EMOTE"');
  });

  it("describes the GIVE_GIFT target shape and the optional emotion field", () => {
    expect(prompt).toContain('{"agentName":string,"itemId":string,"qty":number}');
    expect(prompt).toContain('"emotion": "neutral"|"happy"|"annoyed"|"sad"|"excited"');
  });

  it("explains the new actions in the world rules", () => {
    expect(prompt).toContain("GIVE_GIFT");
    expect(prompt).toContain("EMOTE");
    expect(prompt).toMatch(/MEMORIES/);
    expect(prompt).toMatch(/CURRENT PLAN STEP/);
    expect(prompt).toMatch(/RELATIONSHIPS/);
  });

  it("still ends with the exact closing line", () => {
    expect(prompt.endsWith(CLOSING_LINE)).toBe(true);
  });
});

describe("buildUserPrompt — v2 cognition sections", () => {
  it("stays byte-identical to v1 when no v2 fields are present", () => {
    const obs = baseObs();
    expect(buildUserPrompt(obs)).toBe(`${JSON.stringify(obs)}\nWhat do you do next?`);
  });

  it("renders MEMORIES / CURRENT PLAN STEP / RELATIONSHIPS sections before the observation JSON", () => {
    const obs = baseObs();
    obs.memories = [
      { text: "Rusty gave me a parsnip", type: "observation", importance: 7 },
      { text: "I keep running out of seeds", type: "reflection", importance: 6 },
    ];
    obs.self.currentPlanStep = "water the east plot";
    obs.self.relationships = [
      { name: "Rusty", affinity: 12 },
      { name: "Mona", affinity: -3 },
    ];

    const prompt = buildUserPrompt(obs);
    expect(prompt).toContain("MEMORIES:\n- [observation, importance 7] Rusty gave me a parsnip");
    expect(prompt).toContain("- [reflection, importance 6] I keep running out of seeds");
    expect(prompt).toContain("CURRENT PLAN STEP: water the east plot");
    expect(prompt).toContain("RELATIONSHIPS:\n- Rusty: affinity 12\n- Mona: affinity -3");
    expect(prompt.endsWith(`${JSON.stringify(obs)}\nWhat do you do next?`)).toBe(true);

    // Sections come BEFORE the raw observation/action instruction.
    expect(prompt.indexOf("MEMORIES:")).toBeLessThan(prompt.indexOf(JSON.stringify(obs)));
    expect(prompt.indexOf("RELATIONSHIPS:")).toBeLessThan(prompt.indexOf("What do you do next?"));
  });

  it("renders only the sections that are present (plan step alone)", () => {
    const obs = baseObs();
    obs.self.currentPlanStep = "sell crops at the shop";
    const prompt = buildUserPrompt(obs);
    expect(prompt).toContain("CURRENT PLAN STEP: sell crops at the shop");
    expect(prompt).not.toContain("MEMORIES:");
    expect(prompt).not.toContain("RELATIONSHIPS:");
  });

  it("treats empty memories/relationships arrays like absence", () => {
    const obs = baseObs();
    obs.memories = [];
    obs.self.relationships = [];
    const prompt = buildUserPrompt(obs);
    expect(prompt).not.toContain("MEMORIES:");
    expect(prompt).not.toContain("RELATIONSHIPS:");
  });
});

describe("buildImportancePrompt", () => {
  const prompt = buildImportancePrompt("Rusty gave me a gift");

  it("embeds the memory text and the 1-10 poignancy scale", () => {
    expect(prompt).toContain("Rusty gave me a gift");
    expect(prompt).toContain("1 to 10");
    expect(prompt).toContain("poignan");
  });

  it("demands ONLY a single integer", () => {
    expect(prompt).toContain("ONLY a single integer");
    expect(prompt).toContain("no prose, no fences");
  });
});

describe("buildReflectionQuestionsPrompt", () => {
  const prompt = buildReflectionQuestionsPrompt(["memory one", "memory two"]);

  it("lists every recent memory", () => {
    expect(prompt).toContain("- memory one");
    expect(prompt).toContain("- memory two");
  });

  it("asks for the 3 most salient high-level questions as a bare JSON array", () => {
    expect(prompt).toContain("3 most salient high-level questions");
    expect(prompt).toContain("ONLY a JSON array");
    expect(prompt).toContain("no prose, no fences");
  });
});

describe("buildReflectionInsightsPrompt", () => {
  const prompt = buildReflectionInsightsPrompt("Why is Dora out of seeds?", [
    { id: "Dora-m1", text: "bought 5 seeds" },
    { id: "Dora-m2", text: "planted all of them" },
  ]);

  it("embeds the question and every memory with its id", () => {
    expect(prompt).toContain("Why is Dora out of seeds?");
    expect(prompt).toContain("[Dora-m1] bought 5 seeds");
    expect(prompt).toContain("[Dora-m2] planted all of them");
  });

  it("asks for up to 5 insights citing sourceIds as bare JSON", () => {
    expect(prompt).toContain("up to 5 high-level insights");
    expect(prompt).toContain('{"insight": string, "sourceIds": string[]}');
    expect(prompt).toContain("no prose, no fences");
  });
});

describe("buildDailyPlanPrompt", () => {
  const landmarks: Landmark[] = [
    { kind: "shop", pos: { x: 10, y: 5 } },
    { kind: "bed", pos: { x: 2, y: 2 } },
  ];
  const prompt = buildDailyPlanPrompt(
    "Diligent Dora — methodical optimizer",
    4,
    ["I should buy seeds earlier in the day"],
    landmarks,
  );

  it("embeds persona, day, reflections, and landmarks", () => {
    expect(prompt).toContain("Diligent Dora");
    expect(prompt).toContain("day 4");
    expect(prompt).toContain("- I should buy seeds earlier in the day");
    expect(prompt).toContain("- shop at (10,5)");
    expect(prompt).toContain("- bed at (2,2)");
  });

  it("demands exactly 4 steps, one per phase, as a bare JSON object", () => {
    expect(prompt).toContain("exactly 4 steps");
    expect(prompt).toContain("morning, afternoon, evening, night");
    expect(prompt).toContain('{"steps":[{"phase":"morning"|"afternoon"|"evening"|"night"');
    expect(prompt).toContain("ONLY one JSON object");
    expect(prompt).toContain("no prose, no fences");
  });

  it("omits the reflection/landmark sections when empty", () => {
    const bare = buildDailyPlanPrompt("P", 1, [], []);
    expect(bare).not.toContain("YOUR RECENT REFLECTIONS:");
    expect(bare).not.toContain("LANDMARKS:");
    expect(bare).toContain("exactly 4 steps");
  });
});
