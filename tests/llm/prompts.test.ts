import { describe, expect, it } from "vitest";
import type { Observation } from "@contracts/types";
import { buildSystemPrompt, buildUserPrompt } from "../../src/llm/prompts";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt("Diligent Dora — methodical optimizer");

  it("ends with the exact closing line", () => {
    expect(prompt.endsWith("Respond with ONLY one JSON object — no prose, no fences.")).toBe(true);
  });

  it("includes the persona and v1.2 crop economics", () => {
    expect(prompt).toContain("Diligent Dora");
    expect(prompt).toContain("parsnip: grows in 4 days, seed costs 20g");
    expect(prompt).toContain("potato: grows in 6 days, seed costs 40g");
    expect(prompt).toContain("cauliflower: grows in 8 days, seed costs 80g");
    expect(prompt).toContain('"MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"|"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT"');
  });

  it("states the v1.2 per-action energy costs and starting gold", () => {
    expect(prompt).toContain("TILL 2, PLANT 1, WATER 1, HARVEST 2");
    expect(prompt).toContain("moving and every other action cost 0");
    expect(prompt).toContain("you start with 200 gold");
  });
});

describe("buildUserPrompt", () => {
  it("is JSON.stringify(obs) + the question", () => {
    const obs = { time: { day: 1, phase: "morning" } } as Observation;
    expect(buildUserPrompt(obs)).toBe(`${JSON.stringify(obs)}\nWhat do you do next?`);
  });
});
