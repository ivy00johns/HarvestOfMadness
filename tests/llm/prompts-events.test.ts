/**
 * Focused unit tests for the v3 event sections in buildUserPrompt.
 *
 * Verifies that knownEvents and inviteTargets, when present on the Observation,
 * produce the expected text blocks so the live LLM can act on party events.
 * Mirror of the v2 cognition-section tests in prompts-v2.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Observation, SimEvent } from "@contracts/types";
import { buildUserPrompt } from "../../src/llm/prompts";

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
    time: { day: 2, phase: "evening" },
    nearby: { tiles: [], agents: [], landmarks: [] },
    lastAction: null,
    availableActions: ["WAIT", "MOVE_TO"],
    economy: { sells: {}, buys: {} },
  };
}

const SAMPLE_EVENT: SimEvent & { isNow: boolean } = {
  id: "party-d2",
  host: "Social Sage",
  location: { x: 22, y: 15 },
  day: 2,
  phase: "evening",
  description: "a gathering at the tavern",
  isNow: true,
};

describe("buildUserPrompt — v3 event sections", () => {
  it("renders 'Gatherings you know about:' with location coords and HAPPENING NOW marker", () => {
    const obs = baseObs();
    obs.self.knownEvents = [SAMPLE_EVENT];
    const prompt = buildUserPrompt(obs);

    expect(prompt).toContain("Gatherings you know about:");
    expect(prompt).toContain("(22,15)");
    expect(prompt).toContain("HAPPENING NOW");
    expect(prompt).toContain("a gathering at the tavern");
    expect(prompt).toContain("hosted by Social Sage");
    expect(prompt).toContain("day 2 (evening)");
  });

  it("omits HAPPENING NOW marker on the event entry line for a future event", () => {
    const obs = baseObs();
    obs.self.knownEvents = [{ ...SAMPLE_EVENT, isNow: false, day: 3, phase: "evening" }];
    const prompt = buildUserPrompt(obs);

    expect(prompt).toContain("Gatherings you know about:");
    expect(prompt).toContain("day 3 (evening)");
    // The entry line itself must not include the "HAPPENING NOW" suffix.
    const entryLine = prompt
      .split("\n")
      .find((l) => l.includes("day 3 (evening)"));
    expect(entryLine).toBeTruthy();
    expect(entryLine).not.toContain("HAPPENING NOW");
  });

  it("renders 'You are hosting a gathering' block with each invitee name and position", () => {
    const obs = baseObs();
    obs.self.inviteTargets = [
      { name: "Rusty", pos: { x: 40, y: 17 } },
      { name: "Mossy Moss", pos: { x: 29, y: 17 } },
    ];
    const prompt = buildUserPrompt(obs);

    expect(prompt).toContain("You are hosting a gathering");
    expect(prompt).toContain("Rusty");
    expect(prompt).toContain("(40,17)");
    expect(prompt).toContain("Mossy Moss");
    expect(prompt).toContain("(29,17)");
  });

  it("omits Gatherings block when knownEvents is absent", () => {
    const obs = baseObs();
    const prompt = buildUserPrompt(obs);
    expect(prompt).not.toContain("Gatherings you know about:");
  });

  it("omits Gatherings block when knownEvents is empty", () => {
    const obs = baseObs();
    obs.self.knownEvents = [];
    const prompt = buildUserPrompt(obs);
    expect(prompt).not.toContain("Gatherings you know about:");
  });

  it("omits hosting block when inviteTargets is absent", () => {
    const obs = baseObs();
    const prompt = buildUserPrompt(obs);
    expect(prompt).not.toContain("You are hosting a gathering");
  });

  it("omits hosting block when inviteTargets is empty", () => {
    const obs = baseObs();
    obs.self.inviteTargets = [];
    const prompt = buildUserPrompt(obs);
    expect(prompt).not.toContain("You are hosting a gathering");
  });

  it("event sections appear BEFORE the raw observation JSON", () => {
    const obs = baseObs();
    obs.self.knownEvents = [SAMPLE_EVENT];
    const prompt = buildUserPrompt(obs);
    expect(prompt.indexOf("Gatherings you know about:")).toBeLessThan(
      prompt.indexOf(JSON.stringify(obs)),
    );
  });

  it("still ends with raw obs JSON + 'What do you do next?' when events are present", () => {
    const obs = baseObs();
    obs.self.knownEvents = [SAMPLE_EVENT];
    const prompt = buildUserPrompt(obs);
    expect(prompt.endsWith(`${JSON.stringify(obs)}\nWhat do you do next?`)).toBe(true);
  });
});
