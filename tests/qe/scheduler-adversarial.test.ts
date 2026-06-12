/**
 * QE adversarial suite — scheduler under stress (§6 + domain rule 5).
 *
 *  - in-flight cap under an 8-agent burst with jittered router latency
 *  - budget ceiling end-to-end: badge exactly once, mock fallback, and the
 *    NEXT UTC DAY resets the counter + latch (a second day overrun re-badges)
 *  - pause/step semantics beyond the builders' happy path
 *  - a router that REJECTS (hostile/buggy router) — rule 1 says the loop
 *    must never crash
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmResponse, Router } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { Agent, type Persona } from "../../src/agents/Agent";
import { AgentManager } from "../../src/agents/AgentManager";
import { runDecisionCycle } from "../../src/agents/AgentRuntime";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

function waitResponse(model = "stub"): LlmResponse {
  return {
    raw: '{"thought":"qe","say":null,"action":"WAIT"}',
    parsed: { thought: "qe", say: null, action: "WAIT" },
    model,
    latencyMs: 1,
  };
}

function personas(n: number): Persona[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `qe${i}`,
    name: `QE${i}`,
    description: "a qe stress farmer",
    color: 0xffffff,
    start: { x: 3 + (i % 8), y: 6 },
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
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
});

describe("in-flight cap under burst", () => {
  it("8 hungry agents, cap 3, jittered latency: concurrency NEVER exceeds 3", async () => {
    const track = { current: 0, max: 0, calls: 0 };
    // Deterministic jitter: 200..900ms latency per call.
    const jitterRouter: Router = () =>
      new Promise((resolve) => {
        track.current++;
        track.calls++;
        track.max = Math.max(track.max, track.current);
        const latency = 200 + ((track.calls * 137) % 700);
        setTimeout(() => {
          track.current--;
          resolve(waitResponse("jitter"));
        }, latency);
      });

    manager = new AgentManager({
      config: { decisionCooldownMs: 50, maxConcurrentDecisions: 3, maxDecisionsPerDay: 100_000 },
      router: jitterRouter,
    });
    manager.start(personas(8));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(track.max).toBeLessThanOrEqual(3); // the hard cap
    expect(track.max).toBe(3); // and it actually saturates under burst
    expect(track.calls).toBeGreaterThan(20);
    for (const a of manager.agents()) {
      expect(a.decisionsTotal, a.name).toBeGreaterThanOrEqual(1); // no starvation
    }
  });
});

describe("budget ceiling end-to-end (manager) — badge once, mock fallback, UTC reset", () => {
  it("ceiling -> ONE budget_reached -> mock decisions; next UTC day resets and re-arms", async () => {
    vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
    let liveCalls = 0;
    const counting: Router = async () => {
      liveCalls++;
      return waitResponse("live-stub");
    };
    manager = new AgentManager({
      config: { decisionCooldownMs: 200, maxConcurrentDecisions: 3, maxDecisionsPerDay: 4 },
      router: counting,
    });
    manager.start(personas(2));

    await vi.advanceTimersByTimeAsync(3_000);

    // Day 1: exactly `ceiling` live calls, then mock; badge exactly once.
    expect(liveCalls).toBe(4);
    const badgesDay1 = getEventBus()
      .recent()
      .filter((e) => e.kind === "budget_reached");
    expect(badgesDay1).toHaveLength(1);
    const day1Decisions = manager.agents().reduce((s, a) => s + a.decisionsToday, 0);
    expect(day1Decisions).toBeGreaterThan(4); // mock kept the sim alive past the ceiling

    // Roll the UTC day while the sim keeps running.
    vi.setSystemTime(new Date("2026-06-12T00:00:05Z"));
    await vi.advanceTimersByTimeAsync(3_000);

    // Reset happened: live router serves again, per-agent counters restarted.
    expect(liveCalls).toBeGreaterThan(4);
    const day2Decisions = manager.agents().reduce((s, a) => s + a.decisionsToday, 0);
    expect(day2Decisions).toBeLessThan(day1Decisions + 5); // decisionsToday was reset, not cumulative

    // Day 2 overruns again -> a SECOND badge (one per UTC day), not zero, not many.
    await vi.advanceTimersByTimeAsync(3_000);
    const badges = getEventBus()
      .recent()
      .filter((e) => e.kind === "budget_reached");
    expect(badges).toHaveLength(2);
  });
});

describe("pause / step adversarial semantics", () => {
  it("step() while paused ignores the cooldown and runs exactly one cycle each call", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 60_000, maxConcurrentDecisions: 3, maxDecisionsPerDay: 1000 },
      router: async () => waitResponse(),
    });
    manager.start(personas(1));
    manager.pause();

    // Cooldown is a minute; three back-to-back steps must still each run.
    for (let i = 1; i <= 3; i++) {
      await manager.step();
      expect(manager.agents()[0].decisionsTotal).toBe(i);
    }
    // Paused time passing adds nothing.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(manager.agents()[0].decisionsTotal).toBe(3);
  });

  it("pause() also freezes the world clock (TimeSystem)", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 500, maxConcurrentDecisions: 3, maxDecisionsPerDay: 1000 },
      router: async () => waitResponse(),
    });
    manager.start(personas(1));
    const ts = getWorld().timeSystem;
    manager.pause();
    ts.tick(1_000_000);
    expect(getWorld().time().phase).toBe("morning"); // frozen
    manager.resume();
    ts.tick(8_000);
    expect(getWorld().time().phase).toBe("afternoon");
  });

  it("step() is a no-op (not a crash) when no agent is IDLE", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    // Blocks ONLY the first decision; later calls answer instantly.
    const blockOnce: Router = () =>
      new Promise((resolve) => {
        calls++;
        if (calls === 1) release = () => resolve(waitResponse());
        else resolve(waitResponse());
      });
    manager = new AgentManager({
      config: { decisionCooldownMs: 100, maxConcurrentDecisions: 3, maxDecisionsPerDay: 1000 },
      router: blockOnce,
    });
    manager.start(personas(1));
    await vi.advanceTimersByTimeAsync(150); // loop picks up the one agent -> THINKING
    expect(manager.agents()[0].fsm).toBe("THINKING");

    await manager.step(); // nobody IDLE -> resolves immediately, no double-decision
    expect(manager.agents()[0].decisionsTotal).toBe(1);

    manager.pause(); // stop the loop from queueing decision #2
    release!();
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.agents()[0].fsm).toBe("IDLE");
    expect(manager.agents()[0].decisionsTotal).toBe(1);
  });
});

describe("hostile router that REJECTS (rule 1: never crash the loop)", () => {
  // liveRouter/mockRouter never throw, but the Router seam is public and a
  // buggy custom router (or a future regression) returning a rejected promise
  // must not detonate the agent loop. Today runDecisionCycle has no try/catch
  // around the router call, so the rejection propagates and (via
  // AgentManager.loop's un-caught await) becomes an unhandled rejection that
  // silently kills that agent's loop forever. See qa-report issue.
  it.skip("a rejecting router degrades the turn to WAIT instead of throwing (KNOWN GAP — src/agents/AgentRuntime.ts:140)", async () => {
    const agent = new Agent(personas(1)[0]);
    const explosive: Router = async () => {
      throw new Error("upstream meltdown");
    };
    await expect(
      runDecisionCycle(agent, {
        world: getWorld(),
        agents: [agent],
        bus: getEventBus(),
        router: explosive,
        executorOpts: { msPerTile: 0 },
      }),
    ).resolves.toBeUndefined();
    expect(agent.lastAction?.action).toBe("WAIT");
  });

  it("documents the current behavior: the rejection propagates out of runDecisionCycle", async () => {
    const agent = new Agent(personas(1)[0]);
    const explosive: Router = async () => {
      throw new Error("upstream meltdown");
    };
    await expect(
      runDecisionCycle(agent, {
        world: getWorld(),
        agents: [agent],
        bus: getEventBus(),
        router: explosive,
        executorOpts: { msPerTile: 0 },
      }),
    ).rejects.toThrow("upstream meltdown");
  });
});
