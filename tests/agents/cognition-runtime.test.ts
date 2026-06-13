/**
 * Directed runtime + cognition wiring: plan-before-first-decision (rule 12),
 * observation enrichment (memories / currentPlanStep / relationships in the
 * prompt AND the decision trace), rule-9 writes (action results, heard
 * utterances with dedupe, nearby-activity logging), gift_given / agent_emote
 * events, and the both-sides gift effects through the real CognitionSystem.
 * All in mock mode — zero LLM, zero server (rule 7/11/12 mock paths).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, Router, Vec2 } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { runDecisionCycle } from "../../src/agents/AgentRuntime";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

function makeAgent(pos: Vec2, name: string): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: `${name} — a test farmer`,
    color: 0xffffff,
    start: pos,
  });
}

function routerOf(action: AgentAction): Router {
  return async () => ({
    raw: JSON.stringify(action),
    parsed: action,
    model: "stub",
    latencyMs: 1,
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

let cognition: CognitionSystem;
let a: Agent;
let b: Agent;

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
  cognition = new CognitionSystem({ bus: getEventBus() }); // mock mode (no VITE_MODEL_MODE)
  a = makeAgent({ x: 9, y: 9 }, "Alice");
  b = makeAgent({ x: 9, y: 8 }, "Bob"); // 4-adjacent to Alice
  cognition.registerAgent(a);
  cognition.registerAgent(b);
});

async function cycle(agent: Agent, action: AgentAction): Promise<void> {
  await runDecisionCycle(agent, {
    world: getWorld(),
    agents: [a, b],
    bus: getEventBus(),
    router: routerOf(action),
    cognition,
  });
  await flush();
}

describe("plan + enrichment on the decision path", () => {
  it("a DailyPlan exists before the first decision and rides in the prompt/trace", async () => {
    await cycle(a, { thought: "t", say: null, action: "WAIT" });

    // rule 12: plan generated for day 1 before the decision resolved
    const plan = cognition.planner.current("Alice");
    expect(plan?.day).toBe(1);
    expect(plan?.steps).toHaveLength(4);
    expect(a.planStep).toBe(plan!.steps[0].goal); // morning step on the card

    // the serialized observation in the trace carries the v2 fields
    const obs = JSON.parse(a.trace[0].observationJson);
    expect(obs.self.currentPlanStep).toBe(plan!.steps[0].goal);
    expect(Array.isArray(obs.memories)).toBe(true); // the plan memory itself
    expect(obs.memories.length).toBeGreaterThan(0);
    expect(
      getEventBus()
        .recent()
        .some((e) => e.kind === "plan_created" && e.agentName === "Alice"),
    ).toBe(true);
  });

  it("memory texts in the observation are truncated to ~200 chars", async () => {
    await cognition.write("Alice", "observation", "x".repeat(500), 9);
    await cycle(a, { thought: "t", say: null, action: "WAIT" });
    const obs = JSON.parse(a.trace[0].observationJson);
    const texts: string[] = obs.memories.map((m: { text: string }) => m.text);
    expect(texts.some((t) => t.length > 200)).toBe(false);
    expect(texts.some((t) => t.startsWith("xxx"))).toBe(true);
  });
});

describe("rule-9 memory writes", () => {
  it("every resolved action becomes a memory for the actor", async () => {
    await cycle(a, { thought: "t", say: null, action: "TILL", target: { x: 9, y: 8 } });
    const mems = cognition.memory.all("Alice");
    expect(mems.some((m) => m.text.includes("I tilled the ground at (9,8)"))).toBe(true);
    expect(a.memoryCount).toBe(mems.length);
    expect(
      getEventBus()
        .recent()
        .some((e) => e.kind === "memory_written" && e.agentName === "Alice"),
    ).toBe(true);
  });

  it("rejections are remembered too (with the reason)", async () => {
    await cycle(a, { thought: "t", say: null, action: "HARVEST", target: { x: 9, y: 8 } });
    const mems = cognition.memory.all("Alice");
    const fail = mems.find((m) => m.text.startsWith("I tried to HARVEST but failed"));
    expect(fail).toBeDefined();
    expect(fail!.importance).toBe(7); // harvest-fail per rule 9
  });

  it("utterances are heard by same/adjacent-tile agents, deduped per phase", async () => {
    const say = "What a gorgeous morning!";
    await cycle(a, { thought: "t", say, action: "WAIT" });
    await cycle(a, { thought: "t", say, action: "WAIT" }); // same phase, same line
    const heard = cognition.memory
      .all("Bob")
      .filter((m) => m.text === `Alice said: "${say}"`);
    expect(heard).toHaveLength(1); // deduped
    expect(heard[0].importance).toBe(5);
    // speaker does not "hear" herself
    expect(cognition.memory.all("Alice").some((m) => m.text.includes("Alice said"))).toBe(
      false,
    );
  });

  it("out-of-earshot agents hear nothing", async () => {
    b.pos = { x: 13, y: 9 }; // beyond 1 tile
    await cycle(a, { thought: "t", say: "Hello?", action: "WAIT" });
    expect(cognition.memory.all("Bob").some((m) => m.text.includes("Hello?"))).toBe(false);
  });

  it("nearby agents' activity is observed once per pair per phase", async () => {
    b.lastSeenDoing = "watering (8,8)";
    await cycle(a, { thought: "t", say: null, action: "WAIT" });
    await cycle(a, { thought: "t", say: null, action: "WAIT" });
    const seen = cognition.memory
      .all("Alice")
      .filter((m) => m.text === "I saw Bob watering (8,8)");
    expect(seen).toHaveLength(1);
    expect(seen[0].importance).toBe(2);
  });
});

describe("gift + emote through the full cycle", () => {
  it("GIVE_GIFT: transfer, importance-7 memories both sides, +10 affinity both ways, gift_given event", async () => {
    await cycle(a, {
      thought: "t",
      say: "For you, Bob!",
      action: "GIVE_GIFT",
      target: { agentName: "Bob", itemId: "seed:parsnip", qty: 1 },
    });

    expect(a.countItem("seed:parsnip")).toBe(4);
    expect(b.countItem("seed:parsnip")).toBe(6);

    const giverMem = cognition.memory
      .all("Alice")
      .find((m) => m.text === "I gave Bob 1 seed:parsnip as a gift");
    const receiverMem = cognition.memory
      .all("Bob")
      .find((m) => m.text === "Alice gave me 1 seed:parsnip as a gift");
    expect(giverMem?.importance).toBe(7);
    expect(receiverMem?.importance).toBe(7);

    expect(cognition.relationships.get("Alice", "Bob")?.affinity).toBe(10);
    expect(cognition.relationships.get("Bob", "Alice")?.affinity).toBe(10);
    // inspector rows landed on both agents
    expect(a.relationshipRows).toEqual([
      expect.objectContaining({ name: "Bob", affinity: 10 }),
    ]);
    expect(b.relationshipRows).toEqual([
      expect.objectContaining({ name: "Alice", affinity: 10 }),
    ]);

    const gift = getEventBus().recent().find((e) => e.kind === "gift_given");
    expect(gift?.turnId).toBe("Alice-1");
    expect(gift?.payload).toEqual({ from: "Alice", to: "Bob", itemId: "seed:parsnip" });
  });

  it("EMOTE emits agent_emote with the emotion (and defaults to neutral)", async () => {
    await cycle(a, { thought: "t", say: null, action: "EMOTE", emotion: "happy" });
    await cycle(a, { thought: "t", say: null, action: "EMOTE" });
    const emotes = getEventBus().recent().filter((e) => e.kind === "agent_emote");
    expect(emotes.map((e) => e.payload?.emotion)).toEqual(["happy", "neutral"]);
    expect(emotes.every((e) => e.agentName === "Alice")).toBe(true);
  });

  it("TALK_TO grows affinity on both rows and the relationships ride into the next prompt", async () => {
    b.pos = { x: 9, y: 8 };
    await cycle(a, {
      thought: "t",
      say: "How are the parsnips?",
      action: "TALK_TO",
      target: { agentName: "Bob" },
    });
    expect(cognition.relationships.get("Alice", "Bob")?.affinity).toBe(2);
    expect(cognition.relationships.get("Bob", "Alice")?.affinity).toBe(2);

    await cycle(a, { thought: "t", say: null, action: "WAIT" });
    const obs = JSON.parse(a.trace[0].observationJson);
    expect(obs.self.relationships).toEqual([{ name: "Bob", affinity: 2 }]);
  });
});
