/**
 * QE v2 — kill-switch seam (rule 13), adversarial variant: the live-mode
 * manager's router REJECTS outright (routers are documented never to throw —
 * this is exactly the case a conforming implementation must survive anyway).
 *
 *  - llm_offline emits exactly ONCE (latched, reason carries the failure);
 *  - agents DEGRADE AND KEEP ACTING while the router is down (turns keep
 *    resolving as WAIT, the loop never dies);
 *  - the next live success emits llm_recovered exactly once and the latch
 *    re-arms;
 *  - budget_exceeded must NOT read as offline (it is a deliberate state with
 *    its own budget_reached event + per-agent mock fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmResponse, Router, WorldEvent } from "@contracts/types";
import { resetWorldForTests } from "../../src/world/instance";
import { AgentManager } from "../../src/agents/AgentManager";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

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

const TEST_PERSONAS = [
  { id: "k1", name: "Kappa", description: "a test farmer", color: 0x111111, start: { x: 3, y: 6 } },
  { id: "k2", name: "Lambda", description: "a test farmer", color: 0x222222, start: { x: 4, y: 6 } },
];

const WAIT_OK: LlmResponse = {
  raw: '{"thought":"t","say":null,"action":"WAIT"}',
  parsed: { thought: "t", say: null, action: "WAIT" },
  model: "live-stub",
  latencyMs: 1,
};

describe("kill-switch: REJECTING live router", () => {
  it("llm_offline once (latched) → agents keep acting via WAIT → llm_recovered on next success", async () => {
    const state = { mode: "throw" as "throw" | "ok" };
    const flakyRouter: Router = async () => {
      if (state.mode === "throw") throw new Error("ECONNREFUSED 127.0.0.1:8787");
      return WAIT_OK;
    };

    manager = new AgentManager({
      config: { decisionCooldownMs: 300, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: flakyRouter, // injected non-mock router counts as live
      cognition: null,
    });

    const all: WorldEvent[] = [];
    getEventBus().on((e) => all.push(e));
    manager.start(TEST_PERSONAS);

    await vi.advanceTimersByTimeAsync(3_000); // many failing decisions

    // ONE llm_offline, with the failure reason, despite many failed turns.
    const offline = all.filter((e) => e.kind === "llm_offline");
    expect(offline).toHaveLength(1);
    expect(String(offline[0].payload?.reason)).toContain("router_threw");
    expect(String(offline[0].payload?.reason)).toContain("ECONNREFUSED");
    expect(all.filter((e) => e.kind === "llm_recovered")).toHaveLength(0);

    // Agents KEPT ACTING after the meltdown: every failed turn still resolved
    // (degraded to WAIT), with complete chains, for BOTH agents.
    const afterOffline = all.filter((e) => e.seq > offline[0].seq);
    const resolved = afterOffline.filter((e) => e.kind === "action_resolved");
    expect(resolved.length).toBeGreaterThanOrEqual(4);
    for (const name of ["Kappa", "Lambda"]) {
      const mine = resolved.filter((e) => e.agentName === name);
      expect(mine.length, `${name} kept resolving turns while offline`).toBeGreaterThanOrEqual(1);
      for (const e of mine) {
        expect(e.payload?.action, name).toBe("WAIT");
        expect(e.payload?.ok, name).toBe(true);
      }
    }
    // The degraded turns still carry complete event chains.
    const turnIds = new Set(
      afterOffline.filter((e) => e.kind === "turn_start").map((e) => e.turnId),
    );
    expect(turnIds.size).toBeGreaterThanOrEqual(2);
    for (const id of turnIds) {
      const chain = all.filter((e) => e.turnId === id).map((e) => e.kind);
      if (!chain.includes("action_resolved")) continue; // possibly still in flight at cutoff
      expect(chain, String(id)).toContain("llm_call");
      expect(chain, String(id)).toContain("action_chosen");
    }
    // No agent loop died.
    for (const a of manager.agents()) {
      expect(a.decisionsTotal, a.name).toBeGreaterThanOrEqual(3);
      expect(a.budgetFallback, `${a.name} offline ≠ budget fallback`).toBe(false);
    }

    // Recovery: next live success emits llm_recovered exactly once.
    state.mode = "ok";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(all.filter((e) => e.kind === "llm_recovered")).toHaveLength(1);
    expect(all.filter((e) => e.kind === "llm_offline")).toHaveLength(1);

    // The latch re-arms: a second outage emits a SECOND llm_offline.
    state.mode = "throw";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(all.filter((e) => e.kind === "llm_offline")).toHaveLength(2);
  });

  it("budget_exceeded does NOT trip llm_offline: budget_reached + per-agent mock fallback instead", async () => {
    let liveCalls = 0;
    const budgetRouter: Router = async () => {
      liveCalls++;
      return {
        raw: "",
        model: "unknown",
        latencyMs: 1,
        error: "budget_exceeded: daily decision ceiling reached (200)",
      };
    };

    manager = new AgentManager({
      config: { decisionCooldownMs: 300, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: budgetRouter,
      cognition: null,
    });

    const all: WorldEvent[] = [];
    getEventBus().on((e) => all.push(e));
    manager.start([TEST_PERSONAS[0]]);

    await vi.advanceTimersByTimeAsync(3_000);

    // The deliberate state: budget_reached (scope agent), never llm_offline.
    expect(all.some((e) => e.kind === "budget_reached")).toBe(true);
    expect(all.filter((e) => e.kind === "llm_offline")).toHaveLength(0);
    expect(all.filter((e) => e.kind === "llm_recovered")).toHaveLength(0);

    const agent = manager.agents()[0];
    expect(agent.budgetFallback).toBe(true);
    // The fallback is PERMANENT for the agent: exactly one live call ever
    // reached the budget router; everything after re-routes through mock.
    expect(liveCalls).toBe(1);
    const mockCalls = all.filter(
      (e) => e.kind === "llm_call" && e.payload?.model === "mock",
    );
    expect(mockCalls.length).toBeGreaterThanOrEqual(2);
    // ...and the agent kept acting on the heuristic (turns keep resolving).
    expect(
      all.filter((e) => e.kind === "action_resolved").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
