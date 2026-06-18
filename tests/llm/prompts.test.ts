import { describe, expect, it } from "vitest";
import type { Observation } from "@contracts/types";
import {
  buildReplyPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "../../src/llm/prompts";

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

describe("buildReplyPrompt — multi-turn conversation reply (v3 Wave 2)", () => {
  const built = buildReplyPrompt({
    selfPersona: "Grumbling Gus — a gruff perfectionist",
    selfName: "Gus",
    otherName: "Alice",
    affinitySummary: "she helped fix my fence",
    transcriptTail: [
      { speaker: "Alice", text: "Morning, Gus!" },
      { speaker: "Gus", text: "Hmph." },
      { speaker: "Alice", text: "Cold one today." },
    ],
  });

  it("asks for ONE short in-character sentence of ≤ 15 words", () => {
    expect(built.system).toContain("ONE short in-character sentence");
    expect(built.system).toContain("≤ 15 words");
  });

  it("identifies the speaker and the other participant", () => {
    expect(built.system).toContain("You are Gus");
    expect(built.system).toContain("Grumbling Gus — a gruff perfectionist");
    expect(built.system).toContain("talking with Alice");
  });

  it("includes the transcript tail so the reply stays coherent", () => {
    expect(built.user).toContain("Alice: Morning, Gus!");
    expect(built.user).toContain("Gus: Hmph.");
    expect(built.user).toContain("Alice: Cold one today.");
  });

  it("surfaces the relationship summary when provided", () => {
    expect(built.user).toContain("she helped fix my fence");
  });

  it("demands plain text with no quotes (not a JSON decision)", () => {
    expect(built.system.toLowerCase()).toContain("no quotes");
    expect(built.user).toContain("plain text, no quotes");
    // It must NOT carry the decision-prompt JSON closing line.
    expect(built.system).not.toContain("Respond with ONLY one JSON object");
  });

  it("invites a natural wrap-up so a closer can end the exchange", () => {
    expect(built.system.toLowerCase()).toMatch(/wrap up|goodbye/);
  });

  it("degrades gracefully with an empty transcript tail and no affinity", () => {
    const minimal = buildReplyPrompt({
      selfPersona: "a quiet farmer",
      selfName: "Bo",
      otherName: "Cleo",
      affinitySummary: "",
      transcriptTail: [],
    });
    expect(minimal.user).toContain("Cleo");
    expect(minimal.user).not.toContain("Your relationship");
  });
});
