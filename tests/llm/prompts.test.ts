import { describe, expect, it } from "vitest";
import type { Observation } from "@contracts/types";
import { buildSystemPrompt, buildUserPrompt } from "../../src/llm/prompts";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt("Diligent Dora — methodical optimizer");

  it("ends with the exact closing line", () => {
    expect(prompt.endsWith("Respond with ONLY one JSON object — no prose, no fences.")).toBe(true);
  });

  it("includes the persona and §7 crop economics", () => {
    expect(prompt).toContain("Diligent Dora");
    expect(prompt).toContain("parsnip: grows in 4 days, seed costs 20g");
    expect(prompt).toContain("cauliflower: grows in 8 days, seed costs 80g");
    expect(prompt).toContain('"MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"|"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT"');
  });
});

describe("buildUserPrompt", () => {
  it("is JSON.stringify(obs) + the question", () => {
    const obs = { time: { day: 1, phase: "morning" } } as Observation;
    expect(buildUserPrompt(obs)).toBe(`${JSON.stringify(obs)}\nWhat do you do next?`);
  });
});
