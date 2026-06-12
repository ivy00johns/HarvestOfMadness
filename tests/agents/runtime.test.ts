/**
 * AgentRuntime — parse-retry-once discipline (PDoM port), budget fallback,
 * event-chain shape, and the decision trace.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LlmResponse, Router, WorldEvent } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { Agent } from "../../src/agents/Agent";
import { TRACE_CAP } from "../../src/agents/Agent";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";
import { runDecisionCycle } from "../../src/agents/AgentRuntime";

function makeAgent(name = "Tester"): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: "a test farmer",
    color: 0xffffff,
    start: { x: 9, y: 9 },
  });
}

const WAIT_RAW = '{"thought":"resting","say":null,"action":"WAIT"}';

function waitResponse(): LlmResponse {
  return {
    raw: WAIT_RAW,
    parsed: { thought: "resting", say: null, action: "WAIT" },
    model: "stub",
    latencyMs: 2,
    tokensIn: 10,
    tokensOut: 5,
  };
}

function run(agent: Agent, router: Router, agents: Agent[] = [agent]) {
  return runDecisionCycle(agent, {
    world: getWorld(),
    agents,
    bus: getEventBus(),
    router,
    executorOpts: { msPerTile: 0 },
  });
}

function events(): WorldEvent[] {
  return getEventBus().recent();
}

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
});

describe("parse retry discipline", () => {
  it("retries once on parse failure, then WAITs and emits parse_failure", async () => {
    const agent = makeAgent();
    let calls = 0;
    const router: Router = async (req) => {
      calls++;
      if (calls === 2) {
        // the retry prompt carries the appended problem statement
        expect(req.user).toMatch(/could not be parsed/);
      }
      return { raw: "nonsense, no json here", model: "stub", latencyMs: 1 };
    };
    await run(agent, router);

    expect(calls).toBe(2);
    const kinds = events().map((e) => e.kind);
    expect(kinds.filter((k) => k === "llm_call")).toHaveLength(2);
    expect(kinds).toContain("parse_failure");
    expect(agent.lastAction).toMatchObject({ action: "WAIT", ok: true });
    expect(agent.trace[0]).toMatchObject({ parsedOk: false, action: null });
  });

  it("a successful retry executes normally with no parse_failure", async () => {
    const agent = makeAgent();
    let calls = 0;
    const router: Router = async () => {
      calls++;
      return calls === 1
        ? { raw: "garbage", model: "stub", latencyMs: 1 }
        : waitResponse();
    };
    await run(agent, router);

    expect(calls).toBe(2);
    const kinds = events().map((e) => e.kind);
    expect(kinds).not.toContain("parse_failure");
    expect(agent.trace[0]).toMatchObject({ parsedOk: true, action: "WAIT" });
  });

  it("a clean first response never retries", async () => {
    const agent = makeAgent();
    let calls = 0;
    const router: Router = async () => {
      calls++;
      return waitResponse();
    };
    await run(agent, router);
    expect(calls).toBe(1);
  });
});

describe("budget fallback (domain rule 5)", () => {
  const budgetRouter: Router = async () => ({
    raw: "",
    model: "unknown",
    latencyMs: 3,
    error: "budget_exceeded: daily ceiling hit",
  });

  it("switches the agent permanently to mock and emits budget_reached once", async () => {
    const agent = makeAgent();
    await run(agent, budgetRouter);

    expect(agent.budgetFallback).toBe(true);
    const budgetEvents = events().filter((e) => e.kind === "budget_reached");
    expect(budgetEvents).toHaveLength(1);
    // the same turn was re-decided by the mock heuristic
    const llmCalls = events().filter((e) => e.kind === "llm_call");
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[1].payload?.model).toBe("mock");
    expect(agent.lastAction).not.toBeNull();

    // next decision skips the live router entirely, no second budget event
    let liveCalls = 0;
    const counting: Router = async () => {
      liveCalls++;
      return waitResponse();
    };
    await run(agent, counting);
    expect(liveCalls).toBe(0);
    expect(events().filter((e) => e.kind === "budget_reached")).toHaveLength(1);
  });

  it("a non-budget router error degrades to WAIT without retry", async () => {
    const agent = makeAgent();
    let calls = 0;
    const router: Router = async () => {
      calls++;
      return { raw: "", model: "unknown", latencyMs: 1, error: "upstream_error: 502" };
    };
    await run(agent, router);
    expect(calls).toBe(1);
    expect(agent.budgetFallback).toBe(false);
    expect(agent.lastAction).toMatchObject({ action: "WAIT", ok: true });
    expect(events().map((e) => e.kind)).not.toContain("parse_failure");
  });
});

describe("event chain + trace", () => {
  it("emits turn_start -> llm_call -> action_chosen -> action_resolved under one turnId", async () => {
    const agent = makeAgent();
    await run(agent, async () => waitResponse());

    const evts = events();
    const turnId = `${agent.name}-1`;
    expect(evts.every((e) => e.turnId === turnId)).toBe(true);
    expect(evts.map((e) => e.kind)).toEqual([
      "turn_start",
      "llm_call",
      "action_chosen",
      "action_resolved",
    ]);
    const resolved = evts[evts.length - 1];
    expect(resolved.payload).toMatchObject({ ok: true, energy: 100, gold: 200 });
  });

  it("emits agent_speech when say is non-null and updates goal/lastSeenDoing", async () => {
    const agent = makeAgent();
    const router: Router = async () => ({
      raw: "",
      parsed: {
        thought: "chatty",
        say: "Hello world!",
        action: "WAIT",
        goal: "make friends",
      },
      model: "stub",
      latencyMs: 1,
    });
    await run(agent, router);

    const speech = events().find((e) => e.kind === "agent_speech");
    expect(speech?.payload?.say).toBe("Hello world!");
    expect(agent.goal).toBe("make friends");
    expect(agent.lastThought).toBe("chatty");
    expect(agent.lastSay).toBe("Hello world!");
    expect(agent.lastSeenDoing).toBe("idling");
  });

  it("records a DecisionTraceEntry per decision, newest first, capped", async () => {
    const agent = makeAgent();
    for (let i = 0; i < TRACE_CAP + 5; i++) {
      await run(agent, async () => waitResponse());
    }
    expect(agent.trace).toHaveLength(TRACE_CAP);
    expect(agent.trace[0].turnId).toBe(`${agent.name}-${TRACE_CAP + 5}`);
    expect(agent.trace[0]).toMatchObject({
      parsedOk: true,
      action: "WAIT",
      model: "stub",
      latencyMs: 2,
      tokensIn: 10,
      tokensOut: 5,
      rawResponse: WAIT_RAW,
    });
    expect(JSON.parse(agent.trace[0].observationJson).self.name).toBe(agent.name);
    expect(agent.decisionsTotal).toBe(TRACE_CAP + 5);
  });
});
