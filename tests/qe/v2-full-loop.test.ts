/**
 * QE v2 — full-loop mock integration WITH cognition, multi-day, adversarial
 * degradation: 3 persona agents on the default mockRouter run ~4 game days
 * under fake timers while the cognition layer believes it is LIVE but every
 * cognition LLM call fails (error-LlmResponse, exactly what liveRouter
 * produces with the server down) and every embeddings call REJECTS outright.
 *
 * This is the cross-agent seam no role-agent owned: rules 9/10/11/12 must
 * hold simultaneously under total endpoint failure with zero unhandled
 * rejections, while the v1 economy/energy invariants keep holding.
 *
 * Asserts:
 *  (a) memories accumulate per rule 9 for every agent;
 *  (b) at least one reflection fires (threshold 30) citing REAL sourceIds;
 *  (c) every day ≥ 2 has a 4-step plan BEFORE the agent's first decision
 *      of that day (plan_created.seq < first llm_call.seq of a turn that
 *      STARTED on that day);
 *  (d) covered in gift-adversarial.test.ts (deterministic affinity seam);
 *  (e) plan_created / reflection / memory_written / (relationship_updated)
 *      payloads have the exact contract shapes;
 *  (f) ZERO unhandled rejections despite the rejecting embed fn;
 *  (g) v1 invariants: gold finite & ≥0, energy 0..100, inventory positive
 *      integers, throughout the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmResponse, Router, WorldEvent } from "@contracts/types";
import { ENERGY_START } from "@contracts/types";
import { getTimeSystem, getWorld, resetWorldForTests } from "../../src/world/instance";
import { AgentManager } from "../../src/agents/AgentManager";
import { CognitionSystem } from "../../src/agents/Cognition";
import { PERSONAS } from "../../src/agents/personas";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

let manager: AgentManager | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetWorldForTests();
  resetEventBusForTests();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  manager?.stop();
  manager = null;
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
  // give any stray rejection a real tick to surface before we stop listening
  await new Promise((r) => setTimeout(r, 0));
  process.removeListener("unhandledRejection", onUnhandled);
});

/** What liveRouter resolves with when the proxy is down — NEVER a throw. */
const downCognitionRouter: Router = async (): Promise<LlmResponse> => ({
  raw: "",
  model: "unknown",
  latencyMs: 1,
  error: "upstream_error: proxy unreachable",
});

describe("v2 full loop: 3 agents × 4 days × cognition under total endpoint failure", () => {
  it("memories/reflections/plans flow, no unhandled rejection, v1 invariants hold", async () => {
    const bus = getEventBus();
    const cognition = new CognitionSystem({
      bus,
      live: () => true, // cognition believes it is live...
      router: downCognitionRouter, // ...every completion fails (server down)
      embed: () => Promise.reject(new Error("embeddings endpoint down")), // hostile: REJECTS
    });

    manager = new AgentManager({
      config: {
        decisionCooldownMs: 1000,
        maxConcurrentDecisions: 3,
        maxDecisionsPerDay: 1_000_000,
      },
      cognition,
      // no router injected -> getRouter() -> mockRouter (decisions stay $0)
    });

    const all: WorldEvent[] = [];
    bus.on((e) => all.push(e));

    manager.start(PERSONAS.slice(0, 3)); // Dora + Rusty + Sage

    const world = getWorld();
    const ts = getTimeSystem();
    // ~4 full in-game days (day ≥ 5), sampling invariants (g) as it runs.
    for (let i = 0; i < 10_000 && world.time().day < 5; i++) {
      await vi.advanceTimersByTimeAsync(250);
      ts.tick(250);
      if (i % 16 === 0) {
        for (const a of manager.agents()) {
          expect(Number.isFinite(a.gold), `${a.name} gold finite`).toBe(true);
          expect(a.gold, `${a.name} gold ≥ 0`).toBeGreaterThanOrEqual(0);
          expect(a.energy, `${a.name} energy floor`).toBeGreaterThanOrEqual(0);
          expect(a.energy, `${a.name} energy cap`).toBeLessThanOrEqual(ENERGY_START);
          for (const item of a.inventory) {
            expect(Number.isInteger(item.qty), `${a.name} ${item.itemId} integer`).toBe(true);
            expect(item.qty, `${a.name} ${item.itemId} ≥ 1`).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
    expect(world.time().day, "~4 in-game days elapsed").toBeGreaterThanOrEqual(5);

    manager.stop();
    await vi.advanceTimersByTimeAsync(15_000); // drain in-flight cycles

    const agents = manager.agents();
    expect(agents).toHaveLength(3);

    // ---- (f) no unhandled rejection anywhere, despite the rejecting embed
    expect(unhandled, `unhandled rejections: ${unhandled.map(String).join("; ")}`).toEqual([]);

    // ---- agents kept ACTING the whole run (degradation, not death)
    const resolvedOk = all.filter(
      (e) => e.kind === "action_resolved" && e.payload?.ok === true,
    );
    expect(resolvedOk.length).toBeGreaterThan(30);
    for (const a of agents) {
      expect(a.decisionsTotal, a.name).toBeGreaterThan(10);
      expect(a.fsm, a.name).toBe("IDLE");
    }
    const okVerbs = new Set(resolvedOk.map((e) => String(e.payload?.action)));
    for (const verb of ["TILL", "PLANT", "WATER", "SLEEP"]) {
      expect(okVerbs.has(verb), `farm verb ${verb} still happens`).toBe(true);
    }

    // ---- (a) rule-9 memory accumulation, per agent, embeddings all absent
    for (const a of agents) {
      const stream = cognition.memory.all(a.name);
      expect(stream.length, `${a.name} memory stream`).toBeGreaterThan(10);
      expect(
        stream.filter((m) => m.type === "observation").length,
        `${a.name} observation memories`,
      ).toBeGreaterThan(5);
      expect(a.memoryCount, `${a.name} card counter mirrors store`).toBe(stream.length);
      // the rejecting embed fn means no memory ever got a vector — and that
      // must be SILENT (covered by (f)), with retrieval degrading to rel=0
      expect(stream.every((m) => m.embedding === undefined), a.name).toBe(true);
      for (const m of stream) {
        expect(m.importance, m.id).toBeGreaterThanOrEqual(1);
        expect(m.importance, m.id).toBeLessThanOrEqual(10);
        expect(m.agentName).toBe(a.name);
      }
    }

    // ---- (b) at least one reflection fired and cites REAL memory ids
    const reflectionEvents = all.filter((e) => e.kind === "reflection");
    expect(reflectionEvents.length, "≥1 reflection across the run").toBeGreaterThanOrEqual(1);
    let checkedReflections = 0;
    for (const a of agents) {
      const ids = new Set(cognition.memory.all(a.name).map((m) => m.id));
      const reflections = cognition.memory
        .all(a.name)
        .filter((m) => m.type === "reflection");
      for (const r of reflections) {
        checkedReflections++;
        expect(r.sourceIds, `${r.id} cites sources`).toBeDefined();
        expect(r.sourceIds!.length, `${r.id} non-empty sources`).toBeGreaterThan(0);
        for (const src of r.sourceIds!) {
          expect(ids.has(src), `${r.id} cites REAL id ${src}`).toBe(true);
          expect(src, "no self-citation").not.toBe(r.id);
        }
      }
      expect(a.reflectionCount, `${a.name} card counter`).toBe(reflections.length);
    }
    expect(checkedReflections).toBeGreaterThanOrEqual(1);

    // ---- (c) every day ≥2: a 4-step plan exists BEFORE the agent's first
    //      decision of that day. Anchor each llm_call to the day its TURN
    //      started on (turn chains can legally straddle a SLEEP boundary).
    const turnStartDay = new Map<string, number>();
    for (const e of all) {
      if (e.kind === "turn_start" && e.turnId) turnStartDay.set(e.turnId, e.day);
    }
    const maxDay = world.time().day;
    let planChecks = 0;
    for (const a of agents) {
      for (let d = 2; d <= maxDay; d++) {
        const firstCall = all.find(
          (e) =>
            e.kind === "llm_call" &&
            e.agentName === a.name &&
            e.turnId !== undefined &&
            turnStartDay.get(e.turnId) === d,
        );
        if (!firstCall) continue; // agent made no decision that day
        const plan = all.find(
          (e) =>
            e.kind === "plan_created" &&
            e.agentName === a.name &&
            e.payload?.day === d,
        );
        expect(plan, `${a.name} has a day-${d} plan`).toBeDefined();
        expect(plan!.seq, `${a.name} day-${d} plan precedes first decision`).toBeLessThan(
          firstCall.seq,
        );
        expect(plan!.payload?.steps, `${a.name} day-${d} 4 steps`).toHaveLength(4);
        planChecks++;
      }
      // live planner failed every time -> mock fallback still yields 4 steps
      expect(cognition.planner.current(a.name)?.steps).toHaveLength(4);
      expect(a.planStep, `${a.name} card planStep populated`).toBeTruthy();
    }
    expect(planChecks, "plan-before-decision verified for real days").toBeGreaterThanOrEqual(3);

    // ---- (e) contract payload shapes on the v2 event stream
    for (const e of all.filter((x) => x.kind === "plan_created")) {
      expect(typeof e.payload?.day).toBe("number");
      const steps = e.payload?.steps as unknown[];
      expect(Array.isArray(steps)).toBe(true);
      expect(steps).toHaveLength(4);
      for (const s of steps) expect(typeof s).toBe("string");
      expect(e.agentName).toBeTruthy();
    }
    for (const e of reflectionEvents) {
      const insightIds = e.payload?.insightIds as unknown[];
      expect(Array.isArray(insightIds), "reflection.insightIds").toBe(true);
      expect(insightIds.length).toBeGreaterThan(0);
      for (const id of insightIds) expect(typeof id).toBe("string");
    }
    const memWritten = all.filter((e) => e.kind === "memory_written");
    expect(memWritten.length).toBeGreaterThan(20);
    for (const e of memWritten) {
      expect(typeof e.payload?.memoryId).toBe("string");
      expect(["observation", "reflection", "plan"]).toContain(e.payload?.type);
      const imp = e.payload?.importance as number;
      expect(imp).toBeGreaterThanOrEqual(1);
      expect(imp).toBeLessThanOrEqual(10);
    }
    for (const e of all.filter((x) => x.kind === "relationship_updated")) {
      expect(typeof e.payload?.otherName).toBe("string");
      expect(typeof e.payload?.affinity).toBe("number");
      expect(typeof e.payload?.delta).toBe("number");
      expect(Math.abs(e.payload?.affinity as number)).toBeLessThanOrEqual(100);
    }

    // ---- the failed live cognition calls were actually ATTEMPTED (this run
    //      really exercised the degradation seam, not a silent mock config)
    const m = cognition.metrics;
    expect(
      m.planCalls + m.reflectionCalls + m.importanceCalls + m.relationshipCalls,
      "live cognition calls were attempted and failed gracefully",
    ).toBeGreaterThan(0);

    // ---- retrieval enrichment survived total embedding failure: prompts
    //      carried plan step + memories (trace records the exact serialized obs)
    const traced = agents.find((a) => a.trace.length > 0)!;
    const lastObs = JSON.parse(traced.trace[0].observationJson) as {
      self: { currentPlanStep?: string | null };
      memories?: { text: string; type: string; importance: number }[];
    };
    expect(lastObs.self).toHaveProperty("currentPlanStep");
    expect(Array.isArray(lastObs.memories)).toBe(true);
    expect(lastObs.memories!.length).toBeGreaterThan(0);
    expect(lastObs.memories!.length).toBeLessThanOrEqual(5); // top-k cap
  }, 120_000);
});
