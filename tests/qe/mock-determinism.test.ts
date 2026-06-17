/**
 * QE adversarial suite — mockRouter determinism (contracts v1.2: "runs replay
 * identically", no Math.random anywhere in the decision path).
 *
 * Same observation -> byte-identical LlmResponse, across calls, across
 * shuffled call orders, and across multiple in-game days. Flavor (reckless
 * skip-water, social chat) must hash only on (agentName, day).
 */
import { describe, expect, it } from "vitest";
import type { LlmRequest, Observation } from "@contracts/types";
import { mockRouter } from "../../src/llm/mock";
import { buildUserPrompt, buildSystemPrompt } from "../../src/llm/prompts";

function baseObservation(overrides: Partial<Observation["self"]> = {}, day = 1): Observation {
  return {
    self: {
      name: "Rusty",
      persona: "Reckless Rusty, plants cheap and forgets to water",
      role: "farmer",
      pos: { x: 9, y: 8 },
      energy: 80,
      gold: 120,
      inventory: [{ itemId: "seed:parsnip", qty: 2 }],
      goal: null,
      ...overrides,
    },
    time: { day, phase: "morning" },
    nearby: {
      tiles: [
        { x: 8, y: 8, type: "soil" },
        { x: 9, y: 8, type: "soil" },
        { x: 10, y: 8, type: "tilled" },
        { x: 9, y: 9, type: "tilled", crop: { kind: "parsnip", stage: 1, watered: false, ready: false } },
        { x: 9, y: 7, type: "grass" },
      ],
      agents: [{ name: "Dora", pos: { x: 10, y: 9 }, lastSeenDoing: "tilling" }],
      landmarks: [
        { kind: "bed", pos: { x: 3, y: 4 } },
        { kind: "shop", pos: { x: 19, y: 4 } },
      ],
    },
    lastAction: null,
    availableActions: ["MOVE_TO", "TILL", "PLANT", "WATER", "TALK_TO", "WAIT"],
    economy: { sells: { "crop:parsnip": 35 }, buys: { "seed:parsnip": 20 } },
  };
}

function reqFor(obs: Observation): LlmRequest {
  return {
    agentId: obs.self.name,
    system: buildSystemPrompt(obs.self.persona),
    user: buildUserPrompt(obs),
  };
}

describe("identical observation -> identical decision", () => {
  it("50 repeated calls return byte-identical raw + parsed + latency", async () => {
    const req = reqFor(baseObservation());
    const first = await mockRouter(req);
    expect(first.model).toBe("mock");
    expect(first.latencyMs).toBeGreaterThanOrEqual(0);
    expect(first.latencyMs).toBeLessThanOrEqual(5);
    for (let i = 0; i < 50; i++) {
      const next = await mockRouter(req);
      expect(next.raw).toBe(first.raw);
      expect(next.parsed).toEqual(first.parsed);
      expect(next.latencyMs).toBe(first.latencyMs);
    }
  });

  it("interleaving other agents' calls does not perturb the decision (no hidden state)", async () => {
    const rustyReq = reqFor(baseObservation());
    const doraReq = reqFor(baseObservation({ name: "Dora", persona: "Diligent Dora" }));
    const aloneRaw = (await mockRouter(rustyReq)).raw;

    const interleavedRaws: string[] = [];
    for (let i = 0; i < 10; i++) {
      await mockRouter(doraReq);
      interleavedRaws.push((await mockRouter(rustyReq)).raw);
    }
    for (const raw of interleavedRaws) expect(raw).toBe(aloneRaw);
  });
});

describe("multi-day determinism", () => {
  it("per-day decisions replay identically across two simulated 10-day passes", async () => {
    const passes: string[][] = [];
    for (let pass = 0; pass < 2; pass++) {
      const seq: string[] = [];
      for (let day = 1; day <= 10; day++) {
        for (const phase of ["morning", "afternoon", "evening", "night"] as const) {
          const obs = baseObservation({}, day);
          obs.time = { day, phase };
          seq.push((await mockRouter(reqFor(obs))).raw);
        }
      }
      passes.push(seq);
    }
    expect(passes[0]).toEqual(passes[1]);
    // With this static scene the ladder always picks PLANT (step 3) — the
    // point here is replay identity, not variety.
    expect(passes[0].every((raw) => raw === passes[0][0])).toBe(true);
  });

  it("reckless skip-water flavor is a pure function of (name, day)", async () => {
    for (let day = 1; day <= 8; day++) {
      const obs = baseObservation({}, day);
      const a = (await mockRouter(reqFor(obs))).raw;
      const b = (await mockRouter(reqFor(obs))).raw;
      expect(a, `day ${day}`).toBe(b);
    }
  });
});

describe("hostile prompt bodies never break the mock", () => {
  it("garbage user prompt degrades to a deterministic WAIT", async () => {
    const req: LlmRequest = { agentId: "X", system: "s", user: "not json at all }{" };
    const r1 = await mockRouter(req);
    const r2 = await mockRouter(req);
    expect(r1.parsed?.action).toBe("WAIT");
    expect(r1.raw).toBe(r2.raw);
  });

  // mockRouter is the budget-fallback safety net, so it must never reject.
  // RESOLVED in 3b91777: normalizeObservation coerces any parsed object into
  // a safe Observation (missing fields default conservatively) and decide()
  // is belt-and-braces wrapped, so a partial observation now yields a valid
  // action instead of a TypeError rejection.
  it("an observation missing fields does not throw", async () => {
    const req: LlmRequest = {
      agentId: "X",
      system: "s",
      user: '{"self":{"name":"X"}} What do you do next?',
    };
    // Partial observation: any valid action is fine, crashing is not.
    const res = await mockRouter(req);
    expect(res.model).toBe("mock");
    expect(res.parsed).toBeDefined();
    // Deterministic too, like every other mock decision.
    expect((await mockRouter(req)).raw).toBe(res.raw);
  });

  it("hostile-shaped observations (arrays, scalars, nulls in fields) all resolve", async () => {
    for (const user of [
      "[1,2,3] What do you do next?",
      '{"self":null,"time":null,"nearby":null} next?',
      '{"self":{"inventory":"not-an-array","pos":{"x":"a","y":null}},"nearby":{"tiles":[{"x":1}]}} next?',
      '{"availableActions":"HARVEST"} next?',
    ]) {
      await expect(mockRouter({ agentId: "X", system: "s", user }), user).resolves.toBeDefined();
    }
  });
});
