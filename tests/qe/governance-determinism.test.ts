/**
 * QE — Wave 4c governance mock determinism.
 *
 * The mock VOTE branch must be a PURE function of (name, proposalId) (+ affinity
 * sign when present), with NO Math.random / Date.now. An observation carrying an
 * activeProposal + an injected VOTE action must route to a byte-identical
 * LlmResponse across repeated calls, shuffled call orders, and multiple in-game
 * days. And VOTE must only ever appear when the observation actually injected it
 * (governance present) — frozen scenes without a proposal stay byte-identical.
 */
import { describe, expect, it } from "vitest";
import type { LlmRequest, Observation } from "@contracts/types";
import { mockRouter } from "../../src/llm/mock";
import { buildSystemPrompt, buildUserPrompt } from "../../src/llm/prompts";

function baseObservation(
  overrides: Partial<Observation["self"]> = {},
  day = 1,
): Observation {
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
      tiles: [{ x: 9, y: 7, type: "grass" }],
      agents: [],
      landmarks: [
        { kind: "bed", pos: { x: 3, y: 4 } },
        { kind: "shop", pos: { x: 19, y: 4 } },
      ],
    },
    lastAction: null,
    availableActions: ["MOVE_TO", "WAIT", "VOTE"],
    economy: { sells: {}, buys: {} },
  };
}

/** An observation that surfaces an open proposal the agent is aware of + unvoted. */
function withProposal(
  self: Partial<Observation["self"]> = {},
  day = 1,
): Observation {
  const obs = baseObservation(self, day);
  obs.self.activeProposal = {
    id: "prop-Alice-d1",
    proposer: "Alice",
    ruleText: "always lend a hand watering a neighbour's thirsty crop when we pass it",
    day: 1,
    awareCount: 4,
    yes: 2,
    no: 1,
  };
  return obs;
}

function reqFor(obs: Observation): LlmRequest {
  return {
    agentId: obs.self.name,
    system: buildSystemPrompt(obs.self.persona),
    user: buildUserPrompt(obs),
  };
}

describe("mock VOTE determinism", () => {
  it("emits VOTE for an injected, unvoted proposal", async () => {
    const res = await mockRouter(reqFor(withProposal()));
    expect(res.parsed?.action).toBe("VOTE");
    const target = res.parsed?.target as { proposalId: string; support: boolean };
    expect(target.proposalId).toBe("prop-Alice-d1");
    expect(typeof target.support).toBe("boolean");
  });

  it("50 repeated calls return byte-identical raw + parsed + latency", async () => {
    const req = reqFor(withProposal());
    const first = await mockRouter(req);
    expect(first.model).toBe("mock");
    for (let i = 0; i < 50; i++) {
      const next = await mockRouter(req);
      expect(next.raw).toBe(first.raw);
      expect(next.parsed).toEqual(first.parsed);
      expect(next.latencyMs).toBe(first.latencyMs);
    }
  });

  it("support is a pure function of (name, proposalId) — stable across days", async () => {
    const supports = new Set<string>();
    for (let day = 1; day <= 10; day++) {
      for (const phase of ["morning", "afternoon", "evening", "night"] as const) {
        const obs = withProposal({}, day);
        obs.time = { day, phase };
        const res = await mockRouter(reqFor(obs));
        const target = res.parsed?.target as { support: boolean };
        supports.add(String(target.support));
      }
    }
    // Same (name, proposalId) across all days/phases → exactly one support value.
    expect(supports.size).toBe(1);
  });

  it("interleaving other agents' votes does not perturb the decision (no hidden state)", async () => {
    const rustyReq = reqFor(withProposal());
    const doraReq = reqFor(withProposal({ name: "Dora", persona: "Diligent Dora" }));
    const aloneRaw = (await mockRouter(rustyReq)).raw;
    for (let i = 0; i < 10; i++) {
      await mockRouter(doraReq);
      expect((await mockRouter(rustyReq)).raw).toBe(aloneRaw);
    }
  });

  it("different agents with the SAME proposalId can disagree (hash differs by name)", async () => {
    const supportFor = async (name: string): Promise<boolean> => {
      const res = await mockRouter(reqFor(withProposal({ name })));
      return (res.parsed?.target as { support: boolean }).support;
    };
    // Names chosen so the djb2 hash parity differs — at least two distinct votes.
    const votes = await Promise.all(
      ["Rusty", "Dora", "Alice", "Bob", "Carol", "Eve"].map(supportFor),
    );
    expect(new Set(votes).size).toBeGreaterThanOrEqual(2);
  });

  it("affinity sign overrides the hash coin-flip (>=0 → yes, <0 → no)", async () => {
    const proYes = withProposal({
      relationships: [{ name: "Alice", affinity: 30 }],
    });
    const proNo = withProposal({
      relationships: [{ name: "Alice", affinity: -30 }],
    });
    const yesRes = await mockRouter(reqFor(proYes));
    const noRes = await mockRouter(reqFor(proNo));
    expect((yesRes.parsed?.target as { support: boolean }).support).toBe(true);
    expect((noRes.parsed?.target as { support: boolean }).support).toBe(false);
    // Deterministic — same input, same output.
    expect((await mockRouter(reqFor(proYes))).raw).toBe(yesRes.raw);
    expect((await mockRouter(reqFor(proNo))).raw).toBe(noRes.raw);
  });

  it("a scene WITHOUT an activeProposal never emits VOTE (frozen-scene safety)", async () => {
    // No activeProposal surfaced AND VOTE not in availableActions → the ladder
    // must fall through to a non-VOTE action.
    const obs = baseObservation();
    obs.availableActions = ["MOVE_TO", "WAIT"]; // VOTE not injected
    const res = await mockRouter(reqFor(obs));
    expect(res.parsed?.action).not.toBe("VOTE");
  });

  it("VOTE available but no activeProposal surfaced → no VOTE (gated on the proposal)", async () => {
    const obs = baseObservation();
    // VOTE in availableActions but activeProposal absent — must not fabricate a vote.
    expect(obs.availableActions).toContain("VOTE");
    const res = await mockRouter(reqFor(obs));
    expect(res.parsed?.action).not.toBe("VOTE");
  });
});
