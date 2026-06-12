/**
 * AgentManager scheduler (§6) — fake timers: cooldown pacing, global
 * in-flight cap, daily ceiling -> mock + budget_reached once, pause halts,
 * step runs exactly one full cycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmResponse, Router } from "@contracts/types";
import { resetWorldForTests } from "../../src/world/instance";
import type { Persona } from "../../src/agents/Agent";
import { AgentManager } from "../../src/agents/AgentManager";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

function waitResponse(model = "stub"): LlmResponse {
  return {
    raw: '{"thought":"t","say":null,"action":"WAIT"}',
    parsed: { thought: "t", say: null, action: "WAIT" },
    model,
    latencyMs: 1,
  };
}

const instantWaitRouter: Router = async () => waitResponse();

function personas(n: number): Persona[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Agent${i}`,
    description: "a test farmer",
    color: 0xffffff,
    start: { x: 3 + i, y: 6 },
  }));
}

let manager: AgentManager | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetWorldForTests();
  resetEventBusForTests();
});

afterEach(async () => {
  manager?.stop();
  manager = null;
  await vi.advanceTimersByTimeAsync(500); // let loops observe stop and exit
  vi.useRealTimers();
});

function totalDecisions(m: AgentManager): number {
  return m.agents().reduce((sum, a) => sum + a.decisionsTotal, 0);
}

describe("cooldown", () => {
  it("paces one agent at ~decisionCooldownMs between decisions", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 2000, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: instantWaitRouter,
    });
    manager.start(personas(1));
    await vi.advanceTimersByTimeAsync(10_000);
    const n = totalDecisions(manager);
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(6); // first ~immediate, then one per 2s
  });

  it("speed multiplier shortens the cooldown", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 2000, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: instantWaitRouter,
    });
    manager.start(personas(1));
    manager.setSpeed(4); // effective cooldown 500ms
    await vi.advanceTimersByTimeAsync(10_000);
    expect(totalDecisions(manager)).toBeGreaterThanOrEqual(12);
  });
});

describe("in-flight semaphore", () => {
  it("never exceeds maxConcurrentDecisions across agents", async () => {
    const track = { current: 0, max: 0 };
    const slowRouter: Router = (_req) =>
      new Promise((resolve) => {
        track.current++;
        track.max = Math.max(track.max, track.current);
        setTimeout(() => {
          track.current--;
          resolve(waitResponse("slow"));
        }, 700);
      });

    manager = new AgentManager({
      config: { decisionCooldownMs: 100, maxConcurrentDecisions: 2, maxDecisionsPerDay: 10_000 },
      router: slowRouter,
    });
    manager.start(personas(4));
    await vi.advanceTimersByTimeAsync(8_000);

    expect(track.max).toBeLessThanOrEqual(2);
    expect(track.max).toBeGreaterThanOrEqual(2); // it actually parallelized
    for (const a of manager.agents()) {
      expect(a.decisionsTotal).toBeGreaterThanOrEqual(1); // nobody starved
    }
  });
});

describe("daily ceiling (domain rule 5, manager side)", () => {
  it("past maxDecisionsPerDay all agents flip to mock and budget_reached fires once", async () => {
    let liveCalls = 0;
    const counting: Router = async () => {
      liveCalls++;
      return waitResponse("live-stub");
    };
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 3 },
      router: counting,
    });
    manager.start(personas(1));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(liveCalls).toBe(3); // decisions 1-3 live, 4+ via mockRouter
    expect(totalDecisions(manager)).toBeGreaterThan(3); // still deciding
    const budgetEvents = getEventBus()
      .recent()
      .filter((e) => e.kind === "budget_reached");
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0].payload).toMatchObject({ scope: "manager", ceiling: 3 });
    // post-ceiling decisions really came from the mock heuristic
    const lastLlm = getEventBus()
      .recent()
      .filter((e) => e.kind === "llm_call")
      .pop();
    expect(lastLlm?.payload?.model).toBe("mock");
  });
});

describe("pause / resume / step", () => {
  it("pause halts all decisions; resume restarts them", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: instantWaitRouter,
    });
    manager.start(personas(2));
    manager.pause();
    expect(manager.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(totalDecisions(manager)).toBe(0);

    manager.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(totalDecisions(manager)).toBeGreaterThan(0);
  });

  it("step runs exactly one full cycle while paused", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: instantWaitRouter,
    });
    manager.start(personas(2));
    manager.pause();
    await vi.advanceTimersByTimeAsync(500);

    await manager.step();
    expect(totalDecisions(manager)).toBe(1);
    expect(manager.agents().every((a) => a.fsm === "IDLE")).toBe(true);

    await manager.step(); // round-robin: the other agent goes next
    expect(totalDecisions(manager)).toBe(2);
    expect(manager.agents().map((a) => a.decisionsTotal)).toEqual([1, 1]);

    // still paused: time passing does not add decisions
    await vi.advanceTimersByTimeAsync(3_000);
    expect(totalDecisions(manager)).toBe(2);
  });
});

describe("loop immortality (QE hardening)", () => {
  it("an agent loop survives a rejecting router and keeps deciding", async () => {
    const explosive: Router = async () => {
      throw new Error("upstream meltdown");
    };
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: explosive,
    });
    manager.start(personas(2));
    await vi.advanceTimersByTimeAsync(3_000);

    // every turn degraded to WAIT, but the loops never died
    for (const a of manager.agents()) {
      expect(a.decisionsTotal).toBeGreaterThanOrEqual(3);
      expect(a.fsm).toBe("IDLE");
      expect(a.lastAction).toMatchObject({ action: "WAIT", ok: true });
    }
    const errors = getEventBus()
      .recent()
      .filter((e) => e.kind === "llm_call" && e.payload?.error);
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });

  it("an agent loop survives even a bus whose emit throws", async () => {
    let emits = 0;
    const bombBus = {
      emit: () => {
        emits++;
        throw new Error("bus on fire");
      },
      on: () => () => {},
      recent: () => [],
    };
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: instantWaitRouter,
      bus: bombBus,
    });
    manager.start(personas(1));
    await vi.advanceTimersByTimeAsync(2_000);

    // decisions kept being attempted turn after turn despite every emit throwing
    expect(totalDecisions(manager)).toBeGreaterThanOrEqual(3);
    expect(emits).toBeGreaterThanOrEqual(3);
    expect(manager.agents()[0].fsm).toBe("IDLE");
  });
});
