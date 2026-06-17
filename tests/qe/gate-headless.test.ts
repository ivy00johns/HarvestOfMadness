/**
 * QE gate — the kickoff "single hard requirement", headless.
 *
 * 3 persona agents × mockRouter (default getRouter(), rule 7) × ≥5 in-game
 * days under fake timers:
 *   - gold STRICTLY changed (economy actually moved)
 *   - no exception anywhere (an unhandled rejection fails the test run)
 *   - every turnId chain is complete: turn_start -> llm_call(≥1) ->
 *     action_chosen -> action_resolved, in order
 *   - day_advanced count ≥ 5
 * Plus hard state invariants sampled throughout: gold ≥ 0, energy 0..100,
 * inventory quantities positive integers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldEvent } from "@contracts/types";
import { ENERGY_START, STARTING_GOLD } from "@contracts/types";
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

describe("kickoff gate: 3 agents × mockRouter × ≥5 in-game days, headless", () => {
  it("runs ≥5 days: gold changes, chains complete, invariants never violated", async () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(3);
    manager = new AgentManager({
      config: {
        decisionCooldownMs: 1000,
        maxConcurrentDecisions: 3,
        maxDecisionsPerDay: 1_000_000,
      },
      // no router injected -> getRouter() -> mockRouter (VITE_MODEL_MODE unset)
    });

    const all: WorldEvent[] = [];
    getEventBus().on((e) => all.push(e));

    manager.start(PERSONAS.slice(0, 3)); // Dora + Rusty + Sage

    const world = getWorld();
    const ts = getTimeSystem();
    // Drive until 5 full in-game days have passed (day ≥ 6), sampling state
    // invariants as the sim runs. 250ms granularity matches the scene tick.
    for (let i = 0; i < 12_000 && world.time().day < 6; i++) {
      await vi.advanceTimersByTimeAsync(250);
      ts.tick(250);
      if (i % 16 === 0) {
        for (const a of manager.agents()) {
          expect(Number.isFinite(a.gold), `${a.name} gold finite`).toBe(true);
          expect(a.gold, `${a.name} gold ≥ 0`).toBeGreaterThanOrEqual(0);
          expect(a.energy, `${a.name} energy ≥ 0`).toBeGreaterThanOrEqual(0);
          expect(a.energy, `${a.name} energy ≤ 100`).toBeLessThanOrEqual(ENERGY_START);
          for (const item of a.inventory) {
            expect(Number.isInteger(item.qty), `${a.name} ${item.itemId}`).toBe(true);
            expect(item.qty, `${a.name} ${item.itemId}`).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }

    expect(world.time().day, "≥5 full in-game days elapsed").toBeGreaterThanOrEqual(6);

    // Let in-flight cycles drain so every chain closes.
    manager.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    const agents = manager.agents();
    expect(agents).toHaveLength(3);

    // 1) Gold STRICTLY changed for at least one agent.
    expect(
      agents.some((a) => a.gold !== STARTING_GOLD),
      `gold moved: ${agents.map((a) => `${a.name}=${a.gold}`).join(", ")}`,
    ).toBe(true);
    // ...and the economy event stream backs it up.
    const economyEvents = all.filter((e) => e.kind === "economy");
    expect(economyEvents.length).toBeGreaterThanOrEqual(1);

    // 2) day_advanced ≥ 5 (one per slept night).
    const dayAdvanced = all.filter((e) => e.kind === "day_advanced");
    expect(dayAdvanced.length).toBeGreaterThanOrEqual(5);

    // 3) Every decision's chain is COMPLETE under its turnId.
    const byTurn = new Map<string, WorldEvent[]>();
    for (const e of all) {
      if (!e.turnId) continue;
      const list = byTurn.get(e.turnId) ?? [];
      list.push(e);
      byTurn.set(e.turnId, list);
    }
    expect(byTurn.size).toBeGreaterThan(30); // a real multi-day run, not a stub
    for (const [turnId, evts] of byTurn) {
      const kinds = evts.map((e) => e.kind);
      expect(kinds.filter((k) => k === "turn_start"), turnId).toHaveLength(1);
      expect(kinds.filter((k) => k === "llm_call").length, turnId).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((k) => k === "action_chosen"), turnId).toHaveLength(1);
      expect(kinds.filter((k) => k === "action_resolved"), turnId).toHaveLength(1);
      expect(kinds[0], turnId).toBe("turn_start");
      expect(kinds.indexOf("action_resolved"), turnId).toBeGreaterThan(
        kinds.indexOf("action_chosen"),
      );
      // turnId format per contracts/README.md: `${agentName}-${counter}`
      expect(turnId, "turnId format").toMatch(/^.+-\d+$/);
    }

    // 4) Every agent genuinely played all five days.
    for (const a of agents) {
      expect(a.decisionsTotal, a.name).toBeGreaterThan(10);
      expect(a.trace.length, a.name).toBeGreaterThan(0);
      expect(a.fsm, a.name).toBe("IDLE"); // everything drained cleanly
    }

    // 5) The full farm verbs all actually happened across the run
    //    (till -> plant -> water -> sleep -> harvest somewhere in 5 days).
    const resolvedOk = new Set(
      all
        .filter((e) => e.kind === "action_resolved" && e.payload?.ok === true)
        .map((e) => String(e.payload?.action)),
    );
    for (const verb of ["TILL", "PLANT", "WATER", "SLEEP"]) {
      expect(resolvedOk.has(verb), `verb ${verb} succeeded at least once`).toBe(true);
    }
    expect(
      resolvedOk.has("HARVEST") || resolvedOk.has("BUY") || resolvedOk.has("SELL"),
      "economy verbs reached",
    ).toBe(true);
  }, 120_000);
});
