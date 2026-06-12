/**
 * Integration: 2 agents on the mock router (getRouter() default) live through
 * 3+ in-game days under fake timers — gold changes, no exceptions, and every
 * decision's event chain is well-formed (turn_start + llm_call(s) +
 * action_chosen + action_resolved under one turnId).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldEvent } from "@contracts/types";
import { STARTING_GOLD } from "@contracts/types";
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
  await vi.advanceTimersByTimeAsync(1_000);
  vi.useRealTimers();
});

describe("multi-day mock run", () => {
  it("2 agents farm through 3+ in-game days without crashing", async () => {
    // No router injected -> getRouter() per decision -> mockRouter (rule 7).
    manager = new AgentManager({
      config: {
        decisionCooldownMs: 1000,
        maxConcurrentDecisions: 3,
        maxDecisionsPerDay: 100_000,
      },
    });

    // Collect EVERY event (the ring caps at 1000; a 3-day run overflows it).
    const all: WorldEvent[] = [];
    getEventBus().on((e) => all.push(e));

    manager.start(PERSONAS.slice(0, 2)); // Dora + Rusty

    // Drive the sim: scheduler/walking via fake timers, phases via the
    // TimeSystem tick (the WorldScene's job in the browser). Amplified delta
    // so a phase lasts 10s of scheduler time instead of 40s.
    const world = getWorld();
    const ts = getTimeSystem();
    for (let i = 0; i < 3000 && world.time().day < 4; i++) {
      await vi.advanceTimersByTimeAsync(250);
      ts.tick(1000);
    }

    expect(world.time().day).toBeGreaterThanOrEqual(4); // 3 full days passed

    // Let any in-flight cycle finish so chains close.
    manager.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    const agents = manager.agents();
    expect(agents).toHaveLength(2);

    // Economy moved: the mock loop buys seeds (and may sell) along the way.
    expect(agents.some((a) => a.gold !== STARTING_GOLD)).toBe(true);
    // Both agents actually played.
    for (const a of agents) {
      expect(a.decisionsTotal).toBeGreaterThan(5);
      expect(a.energy).toBeGreaterThanOrEqual(0);
      expect(a.trace.length).toBeGreaterThan(0);
    }

    // SLEEP advanced the calendar: one day_advanced per night slept.
    const dayEvents = all.filter((e) => e.kind === "day_advanced");
    expect(dayEvents.length).toBeGreaterThanOrEqual(3);

    // Event chains are well-formed per turnId.
    const byTurn = new Map<string, WorldEvent[]>();
    for (const e of all) {
      if (!e.turnId) continue;
      const list = byTurn.get(e.turnId) ?? [];
      list.push(e);
      byTurn.set(e.turnId, list);
    }
    expect(byTurn.size).toBeGreaterThan(10);
    for (const [turnId, evts] of byTurn) {
      const kinds = evts.map((e) => e.kind);
      expect(kinds.filter((k) => k === "turn_start"), turnId).toHaveLength(1);
      expect(
        kinds.filter((k) => k === "llm_call").length,
        turnId,
      ).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((k) => k === "action_chosen"), turnId).toHaveLength(1);
      expect(kinds.filter((k) => k === "action_resolved"), turnId).toHaveLength(1);
      // ordering: turn_start first, action_resolved after action_chosen
      expect(kinds[0], turnId).toBe("turn_start");
      expect(
        kinds.indexOf("action_resolved"),
        turnId,
      ).toBeGreaterThan(kinds.indexOf("action_chosen"));
      // mock-mode decisions are all $0
      for (const e of evts.filter((x) => x.kind === "llm_call")) {
        expect(e.payload?.model).toBe("mock");
      }
    }

    // Ring buffer honors its cap while the full feed kept flowing.
    expect(getEventBus().recent().length).toBeLessThanOrEqual(1000);
    expect(all.length).toBeGreaterThanOrEqual(getEventBus().recent().length);
  }, 60_000);
});
