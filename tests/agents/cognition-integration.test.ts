/**
 * Mock-mode multi-day cognition integration (fake timers, zero server):
 * memories, reflections, and plans flow for every agent across in-game days
 * with the DEFAULT manager wiring (getRouter() -> mockRouter), proving the
 * generative-agents loop runs at $0 (rules 7/9/11/12). Also pins the live
 * cognition call budget at zero in mock mode, and exercises the v2
 * llm_offline / llm_recovered kill-switch events (rule 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmResponse, Router, WorldEvent } from "@contracts/types";
import { getTimeSystem, getWorld, resetWorldForTests } from "../../src/world/instance";
import { AgentManager } from "../../src/agents/AgentManager";
import { PERSONAS } from "../../src/agents/personas";
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

describe("multi-day mock cognition", () => {
  it("3 agents × mockRouter × 2+ days: plans, memories and reflections flow without a server", async () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(6); // v2: six personas shipped
    manager = new AgentManager({
      config: {
        decisionCooldownMs: 1000,
        maxConcurrentDecisions: 3,
        maxDecisionsPerDay: 1_000_000,
      },
      // no router injected -> getRouter() -> mockRouter; default cognition (mock mode)
    });

    const all: WorldEvent[] = [];
    getEventBus().on((e) => all.push(e));

    manager.start(PERSONAS.slice(0, 3));

    const world = getWorld();
    const ts = getTimeSystem();
    for (let i = 0; i < 8_000 && world.time().day < 3; i++) {
      await vi.advanceTimersByTimeAsync(250);
      ts.tick(250);
    }
    expect(world.time().day).toBeGreaterThanOrEqual(3);

    manager.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    const agents = manager.agents();
    const cognition = manager.cognition()!;
    expect(cognition).not.toBeNull();

    // -- plans: one per agent per day, created BEFORE decisions of that day
    const planEvents = all.filter((e) => e.kind === "plan_created");
    for (const a of agents) {
      const days = planEvents
        .filter((e) => e.agentName === a.name)
        .map((e) => e.payload?.day);
      expect(days, `${a.name} day-1 plan`).toContain(1);
      expect(days.length, `${a.name} planned ≥2 days`).toBeGreaterThanOrEqual(2);
      expect(new Set(days).size, `${a.name} one plan per day`).toBe(days.length);
      expect(a.planStep, `${a.name} card planStep`).toBeTruthy();
      expect(cognition.planner.current(a.name)?.steps).toHaveLength(4);
    }

    // -- memories: rule-9 stream grew for everyone, counters mirror the store
    expect(all.filter((e) => e.kind === "memory_written").length).toBeGreaterThan(10);
    for (const a of agents) {
      const stream = cognition.memory.all(a.name);
      expect(stream.length, `${a.name} memories`).toBeGreaterThan(5);
      expect(a.memoryCount).toBe(stream.length);
      // action results made it in
      expect(stream.some((m) => m.type === "observation")).toBe(true);
      // plans are stored as `plan` memories
      expect(stream.some((m) => m.type === "plan")).toBe(true);
      // mock mode: no embeddings were ever attached (relevance degrades to 0)
      expect(stream.every((m) => m.embedding === undefined)).toBe(true);
    }

    // -- reflections: threshold 30 crossed during the run for at least one agent
    const reflectionEvents = all.filter((e) => e.kind === "reflection");
    expect(reflectionEvents.length).toBeGreaterThanOrEqual(1);
    const reflected = agents.filter((a) => a.reflectionCount > 0);
    expect(reflected.length).toBeGreaterThanOrEqual(1);
    for (const a of reflected) {
      const refl = cognition.memory.all(a.name).filter((m) => m.type === "reflection");
      expect(refl.length).toBe(a.reflectionCount);
      expect(refl.every((m) => (m.sourceIds?.length ?? 0) > 0)).toBe(true);
    }

    // -- prompts carried the cognition sections (trace = exact serialized obs)
    const traced = agents.find((a) => a.trace.length > 0)!;
    const obs = JSON.parse(traced.trace[0].observationJson);
    expect(obs.self).toHaveProperty("currentPlanStep");
    expect(Array.isArray(obs.memories)).toBe(true);
    expect(obs.memories.length).toBeGreaterThan(0);
    expect(obs.memories.length).toBeLessThanOrEqual(5); // top-5 cap

    // -- budget: mock mode makes ZERO live cognition LLM calls
    expect(cognition.metrics).toEqual({
      planCalls: 0,
      reflectionCalls: 0,
      relationshipCalls: 0,
      importanceCalls: 0,
      goalCalls: 0,
    });

    // -- and the kill-switch never fired (nothing live to go offline)
    expect(all.some((e) => e.kind === "llm_offline")).toBe(false);
    expect(all.some((e) => e.kind === "llm_recovered")).toBe(false);
  }, 60_000);
});

describe("llm_offline / llm_recovered (rule 13 kill-switch visibility)", () => {
  const waitAction = '{"thought":"t","say":null,"action":"WAIT"}';

  function switchableRouter(state: { fail: boolean }): Router {
    return async (): Promise<LlmResponse> =>
      state.fail
        ? { raw: "", model: "unknown", latencyMs: 1, error: "upstream_error: 502" }
        : {
            raw: waitAction,
            parsed: { thought: "t", say: null, action: "WAIT" },
            model: "live-stub",
            latencyMs: 1,
          };
  }

  it("first live failure emits llm_offline {reason} once; next live success emits llm_recovered", async () => {
    const state = { fail: true };
    manager = new AgentManager({
      config: { decisionCooldownMs: 300, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: switchableRouter(state), // injected non-mock router counts as live
      cognition: null, // isolate the health latch
    });
    manager.start([
      { id: "p0", name: "Agent0", description: "a test farmer", color: 0xffffff, start: { x: 3, y: 6 } },
    ]);

    await vi.advanceTimersByTimeAsync(2_000); // several failing decisions
    let offline = getEventBus().recent().filter((e) => e.kind === "llm_offline");
    expect(offline).toHaveLength(1); // latched, not spammed
    expect(offline[0].payload).toEqual({ reason: "upstream_error: 502" });
    expect(getEventBus().recent().filter((e) => e.kind === "llm_recovered")).toHaveLength(0);

    state.fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    const recovered = getEventBus().recent().filter((e) => e.kind === "llm_recovered");
    expect(recovered).toHaveLength(1);

    state.fail = true; // the latch re-arms after recovery
    await vi.advanceTimersByTimeAsync(2_000);
    offline = getEventBus().recent().filter((e) => e.kind === "llm_offline");
    expect(offline).toHaveLength(2);
  });

  it("budget_exceeded keeps its own event (budget_reached) and never reads as offline", async () => {
    const budgetRouter: Router = async () => ({
      raw: "",
      model: "unknown",
      latencyMs: 1,
      error: "budget_exceeded: daily server budget hit",
    });
    manager = new AgentManager({
      config: { decisionCooldownMs: 300, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      router: budgetRouter,
      cognition: null,
    });
    manager.start([
      { id: "p0", name: "Agent0", description: "a test farmer", color: 0xffffff, start: { x: 3, y: 6 } },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);

    const events = getEventBus().recent();
    expect(events.some((e) => e.kind === "budget_reached")).toBe(true);
    expect(events.some((e) => e.kind === "llm_offline")).toBe(false);
  });

  it("mock decisions never touch the health latch", async () => {
    manager = new AgentManager({
      config: { decisionCooldownMs: 300, maxConcurrentDecisions: 3, maxDecisionsPerDay: 10_000 },
      cognition: null, // default router -> mockRouter
    });
    manager.start([
      { id: "p0", name: "Agent0", description: "a test farmer", color: 0xffffff, start: { x: 3, y: 6 } },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    const events = getEventBus().recent();
    expect(events.some((e) => e.kind === "llm_offline")).toBe(false);
    expect(events.some((e) => e.kind === "llm_recovered")).toBe(false);
  });
});
