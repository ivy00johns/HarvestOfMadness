/**
 * MortalitySystem — agent mortality (death, suicide/despair, murder) as a
 * deterministic, conservative simulation mechanic.
 *
 * Covers: forced crises fire (energy pinned low N days → starvation; sustained
 * full-gate despair → despair; grudge + adjacency → murder), normal state never
 * dies, a good night's sleep resets the counters, full determinism (two runs
 * deep-equal), murder victim/killer selection (most-negative grudge, name
 * tie-break, adjacency required), dead agents are skipped on the next
 * evaluation, malformed input never throws, and the AgentManager scheduler
 * skips dead agents. Pure-model: no Phaser, no LLM, $0.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ENERGY_START } from "@contracts/types";
import {
  MortalitySystem,
  STARVE_ENERGY,
  STARVE_DAYS,
  DESPAIR_DAYS,
  DESPAIR_ENERGY,
  MURDER_GRUDGE,
  type AffinityLookup,
  type Death,
  type MortalAgentLike,
} from "../../src/agents/Mortality";

/** Crisis-level need vector (several drives pinned at/over the despair gate). */
const CRISIS_NEEDS = {
  energy: 1,
  wealth: 1,
  social: 1,
  novelty: 0.9,
  purpose: 0.9,
};

/** A relaxed (healthy) need vector — no drive in crisis. */
const CALM_NEEDS = {
  energy: 0.2,
  wealth: 0.3,
  social: 0.3,
  novelty: 0.3,
  purpose: 0.4,
};

function makeAgent(p: Partial<MortalAgentLike> & { name: string }): MortalAgentLike {
  return {
    alive: true,
    energy: ENERGY_START,
    gold: 200,
    pos: { x: 0, y: 0 },
    needs: null,
    ...p,
  };
}

/** Affinity lookup backed by a flat {"A|B": n} table; null when absent. */
function affinityFrom(table: Record<string, number>): AffinityLookup {
  return (a, b) => (table[`${a}|${b}`] ?? null);
}

const NO_AFFINITY: AffinityLookup = () => null;

describe("normal state — nobody dies", () => {
  it("rested, solvent, calm agents survive many day-evaluations", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Ana", energy: ENERGY_START, gold: 200, needs: CALM_NEEDS }),
      makeAgent({ name: "Bo", energy: ENERGY_START, gold: 200, needs: CALM_NEEDS }),
    ];
    for (let day = 1; day <= 12; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
  });

  it("positive/neutral relationships never trigger murder even when adjacent", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Ana", pos: { x: 5, y: 5 } }),
      makeAgent({ name: "Bo", pos: { x: 5, y: 5 } }), // same tile, adjacent
    ];
    const aff = affinityFrom({ "Ana|Bo": 40, "Bo|Ana": 12 });
    for (let day = 1; day <= 8; day++) {
      expect(m.evaluate(agents, day, aff)).toEqual([]);
    }
  });
});

describe("starvation", () => {
  it("fires only after STARVE_DAYS consecutive starving evaluations", () => {
    const m = new MortalitySystem();
    const starving = makeAgent({ name: "Famished", energy: STARVE_ENERGY });
    const agents = [starving];
    for (let day = 1; day < STARVE_DAYS; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
    const deaths = m.evaluate(agents, STARVE_DAYS, NO_AFFINITY);
    expect(deaths).toEqual([{ name: "Famished", cause: "starvation" }]);
  });

  it("a single good night's sleep (energy recovered) resets the counter", () => {
    const m = new MortalitySystem();
    const a = makeAgent({ name: "Rester", energy: STARVE_ENERGY });
    const agents = [a];
    // Starve up to the brink (STARVE_DAYS-1 consecutive low days)...
    for (let day = 1; day < STARVE_DAYS; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
    // ...then sleep: energy back to full → counter resets.
    a.energy = ENERGY_START;
    expect(m.evaluate(agents, STARVE_DAYS, NO_AFFINITY)).toEqual([]);
    // Now starve again — must take a FULL STARVE_DAYS run, proving the reset.
    a.energy = STARVE_ENERGY;
    for (let i = 1; i < STARVE_DAYS; i++) {
      expect(m.evaluate(agents, STARVE_DAYS + i, NO_AFFINITY)).toEqual([]);
    }
    expect(m.evaluate(agents, STARVE_DAYS * 2, NO_AFFINITY)).toEqual([
      { name: "Rester", cause: "starvation" },
    ]);
  });

  it("energy at/below the threshold counts; just above does not", () => {
    const m = new MortalitySystem();
    const a = makeAgent({ name: "Edge", energy: STARVE_ENERGY + 1 });
    const agents = [a];
    for (let day = 1; day <= STARVE_DAYS + 3; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
  });
});

describe("despair (suicide)", () => {
  it("fires after DESPAIR_DAYS of the full crisis gate", () => {
    const m = new MortalitySystem();
    // Two isolated, broke, exhausted, in-crisis agents with no positive ties.
    const agents = [
      makeAgent({ name: "Lorn", energy: DESPAIR_ENERGY, gold: 0, needs: CRISIS_NEEDS }),
    ];
    for (let day = 1; day < DESPAIR_DAYS; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
    const deaths = m.evaluate(agents, DESPAIR_DAYS, NO_AFFINITY);
    expect(deaths).toEqual([{ name: "Lorn", cause: "despair" }]);
  });

  it("a positive social tie breaks despair (gate not met)", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Lorn", energy: DESPAIR_ENERGY, gold: 0, needs: CRISIS_NEEDS }),
      makeAgent({ name: "Pal", energy: ENERGY_START, gold: 200, needs: CALM_NEEDS }),
    ];
    // Lorn has a positive tie to Pal → isolated gate fails → never despairs.
    const aff = affinityFrom({ "Lorn|Pal": 30 });
    for (let day = 1; day <= DESPAIR_DAYS + 4; day++) {
      expect(m.evaluate(agents, day, aff)).toEqual([]);
    }
  });

  it("nonzero gold breaks despair (gate not met)", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Lorn", energy: DESPAIR_ENERGY, gold: 50, needs: CRISIS_NEEDS }),
    ];
    for (let day = 1; day <= DESPAIR_DAYS + 4; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
  });

  it("relief on one day resets the despair clock", () => {
    const m = new MortalitySystem();
    const a = makeAgent({ name: "Lorn", energy: DESPAIR_ENERGY, gold: 0, needs: CRISIS_NEEDS });
    const agents = [a];
    for (let day = 1; day < DESPAIR_DAYS; day++) {
      expect(m.evaluate(agents, day, NO_AFFINITY)).toEqual([]);
    }
    // One restful day (energy recovered) resets the clock.
    a.energy = ENERGY_START;
    expect(m.evaluate(agents, DESPAIR_DAYS, NO_AFFINITY)).toEqual([]);
    a.energy = DESPAIR_ENERGY;
    for (let i = 1; i < DESPAIR_DAYS; i++) {
      expect(m.evaluate(agents, DESPAIR_DAYS + i, NO_AFFINITY)).toEqual([]);
    }
    expect(m.evaluate(agents, DESPAIR_DAYS * 2, NO_AFFINITY)).toEqual([
      { name: "Lorn", cause: "despair" },
    ]);
  });
});

describe("murder", () => {
  it("a strong grudge toward an adjacent agent kills that agent", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Killer", pos: { x: 3, y: 3 } }),
      makeAgent({ name: "Victim", pos: { x: 3, y: 4 } }), // Chebyshev 1
    ];
    const aff = affinityFrom({ "Killer|Victim": MURDER_GRUDGE });
    const deaths = m.evaluate(agents, 1, aff);
    expect(deaths).toEqual([{ name: "Victim", cause: "murder", by: "Killer" }]);
  });

  it("a grudge is harmless when the victim is NOT adjacent", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Killer", pos: { x: 0, y: 0 } }),
      makeAgent({ name: "Victim", pos: { x: 9, y: 9 } }), // far away
    ];
    const aff = affinityFrom({ "Killer|Victim": MURDER_GRUDGE - 40 });
    expect(m.evaluate(agents, 1, aff)).toEqual([]);
  });

  it("a grudge just above the floor does NOT trigger murder", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Killer", pos: { x: 3, y: 3 } }),
      makeAgent({ name: "Victim", pos: { x: 3, y: 3 } }),
    ];
    const aff = affinityFrom({ "Killer|Victim": MURDER_GRUDGE + 1 });
    expect(m.evaluate(agents, 1, aff)).toEqual([]);
  });

  it("picks the MOST-negative grudge as the victim (tie-break by name)", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Killer", pos: { x: 5, y: 5 } }),
      makeAgent({ name: "Bart", pos: { x: 5, y: 5 } }),
      makeAgent({ name: "Carl", pos: { x: 5, y: 5 } }),
    ];
    // Carl is hated more than Bart → Carl is the victim.
    const aff = affinityFrom({
      "Killer|Bart": MURDER_GRUDGE - 5,
      "Killer|Carl": MURDER_GRUDGE - 20,
    });
    const deaths = m.evaluate(agents, 1, aff);
    expect(deaths).toEqual([{ name: "Carl", cause: "murder", by: "Killer" }]);
  });
});

describe("determinism + dead-skip", () => {
  it("two fresh systems over identical inputs produce identical Deaths", () => {
    const build = (): MortalAgentLike[] => [
      makeAgent({ name: "Killer", pos: { x: 2, y: 2 } }),
      makeAgent({ name: "Victim", pos: { x: 2, y: 2 } }),
      makeAgent({ name: "Faint", energy: STARVE_ENERGY }),
    ];
    const aff = affinityFrom({ "Killer|Victim": MURDER_GRUDGE - 10 });
    const run = (): Death[][] => {
      const m = new MortalitySystem();
      const agents = build();
      const out: Death[][] = [];
      for (let day = 1; day <= STARVE_DAYS + 1; day++) {
        out.push(m.evaluate(agents, day, aff));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("a reported-dead agent is not re-reported on later evaluations", () => {
    const m = new MortalitySystem();
    const a = makeAgent({ name: "Famished", energy: STARVE_ENERGY });
    const agents = [a];
    for (let day = 1; day < STARVE_DAYS; day++) m.evaluate(agents, day, NO_AFFINITY);
    expect(m.evaluate(agents, STARVE_DAYS, NO_AFFINITY)).toEqual([
      { name: "Famished", cause: "starvation" },
    ]);
    // Still pinned low, but already dead → no further deaths.
    expect(m.evaluate(agents, STARVE_DAYS + 1, NO_AFFINITY)).toEqual([]);
    expect(m.evaluate(agents, STARVE_DAYS + 2, NO_AFFINITY)).toEqual([]);
    expect(m.isAlive("Famished")).toBe(false);
  });

  it("an agent flagged alive=false is excluded as both killer and victim", () => {
    const m = new MortalitySystem();
    const agents = [
      makeAgent({ name: "Killer", pos: { x: 1, y: 1 }, alive: false }),
      makeAgent({ name: "Victim", pos: { x: 1, y: 1 } }),
    ];
    const aff = affinityFrom({ "Killer|Victim": MURDER_GRUDGE - 30 });
    // Dead killer → no murder.
    expect(m.evaluate(agents, 1, aff)).toEqual([]);
  });
});

describe("defensive — malformed input never throws", () => {
  it("handles null/garbage agents, missing fields, bad affinity fn", () => {
    const m = new MortalitySystem();
    expect(() => m.evaluate(null as never, 1, NO_AFFINITY)).not.toThrow();
    expect(() => m.evaluate(undefined as never, 1, NO_AFFINITY)).not.toThrow();
    expect(m.evaluate(null as never, 1, NO_AFFINITY)).toEqual([]);
    const junk = [
      null,
      undefined,
      {},
      { name: 42 },
      makeAgent({ name: "Ok", energy: ENERGY_START }),
    ] as never;
    expect(() => m.evaluate(junk, 1, undefined as never)).not.toThrow();
    expect(m.evaluate(junk, 1, undefined as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AgentManager — the scheduler must SKIP dead agents.
// ---------------------------------------------------------------------------

import { getTimeSystem, getWorld, resetWorldForTests } from "../../src/world/instance";
import { AgentManager } from "../../src/agents/AgentManager";
import { PERSONAS } from "../../src/agents/personas";
import { resetEventBusForTests } from "../../src/agents/events";

describe("AgentManager skips dead agents", () => {
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

  it("a dead agent never advances its decision counters; living agents do", async () => {
    manager = new AgentManager({
      config: {
        decisionCooldownMs: 1000,
        maxConcurrentDecisions: 3,
        maxDecisionsPerDay: 100_000,
      },
    });
    manager.start(PERSONAS.slice(0, 2));
    const [a, b] = manager.agents();
    // Kill the first agent before any cycles run.
    a.alive = false;
    a.causeOfDeath = "starvation";
    a.deathDay = getWorld().time().day;
    const deadBaseline = a.decisionsTotal;

    getTimeSystem().resume();
    await vi.advanceTimersByTimeAsync(8_000);

    // The dead agent never decided again; the living one did, and is still seen.
    expect(a.decisionsTotal).toBe(deadBaseline);
    expect(b.decisionsTotal).toBeGreaterThan(0);
    expect(manager.agents().map((x) => x.name)).toContain(a.name);
    expect(a.alive).toBe(false);
  });
});
