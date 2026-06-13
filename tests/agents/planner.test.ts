/**
 * Planner (rule 12) — exactly 4 steps (one per phase, in order), plan memory
 * + plan_created event, phase advancement, currentStep, per-day idempotency,
 * live smart-tier path with defensive coercion and mock fallback.
 */
import { describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  LlmRequest,
  Phase,
  Router,
  WorldEvent,
} from "@contracts/types";
import {
  coercePlanSteps,
  PLAN_MEMORY_IMPORTANCE,
  PlannerImpl,
  planMemoryText,
} from "../../src/agents/Planner";

const A = "Tester";
const PHASES: Phase[] = ["morning", "afternoon", "evening", "night"];

interface Harness {
  planner: PlannerImpl;
  events: WorldEvent[];
  writes: { agentName: string; text: string; importance: number }[];
  calls: LlmRequest[];
  now: { stamp: GameStamp };
}

function makeHarness(opts: { live?: boolean; router?: Router } = {}): Harness {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => {
      events.push({ ...e, seq: ++seq, ts: Date.now() });
    },
    on: () => () => {},
    recent: () => events,
  };
  const writes: Harness["writes"] = [];
  const calls: LlmRequest[] = [];
  const now = { stamp: { day: 1, phase: "morning" } as GameStamp };
  const planner = new PlannerImpl({
    bus,
    live: () => opts.live ?? false,
    router: async (req) => {
      calls.push(req);
      return opts.router
        ? opts.router(req)
        : { raw: "", model: "none", latencyMs: 0, error: "no router" };
    },
    now: () => now.stamp,
    landmarks: () => [
      { kind: "shop", pos: { x: 19, y: 4 } },
      { kind: "bed", pos: { x: 3, y: 4 } },
    ],
    persona: () => "a social farmer who loves chatting",
    reflections: () => ["I should water more"],
    write: async (agentName, text, importance) => {
      writes.push({ agentName, text, importance });
      return null; // the planner must not depend on the entry
    },
  });
  return { planner, events, writes, calls, now };
}

describe("mock planning", () => {
  it("produces exactly 4 steps, one per phase in order, night ends at bed", async () => {
    const h = makeHarness();
    const plan = await h.planner.planDay(A, 1);
    expect(plan.agentName).toBe(A);
    expect(plan.day).toBe(1);
    expect(plan.steps.map((s) => s.phase)).toEqual(PHASES);
    expect(plan.steps.every((s) => !s.done && s.goal.length > 0)).toBe(true);
    expect(plan.steps[3].targetLandmark).toBe("bed");
    expect(plan.rawText.length).toBeGreaterThan(0);
    expect(h.calls).toHaveLength(0); // $0
  });

  it("stores a plan memory and emits plan_created", async () => {
    const h = makeHarness();
    const plan = await h.planner.planDay(A, 1);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      agentName: A,
      importance: PLAN_MEMORY_IMPORTANCE,
      text: planMemoryText(plan),
    });
    const evts = h.events.filter((e) => e.kind === "plan_created");
    expect(evts).toHaveLength(1);
    expect(evts[0].agentName).toBe(A);
    expect(evts[0].payload).toMatchObject({
      day: 1,
      steps: plan.steps.map((s) => s.goal),
    });
  });

  it("is idempotent per (agent, day) and replaces on a new day", async () => {
    const h = makeHarness();
    const p1 = await h.planner.planDay(A, 1);
    const again = await h.planner.planDay(A, 1);
    expect(again).toBe(p1);
    expect(h.events.filter((e) => e.kind === "plan_created")).toHaveLength(1);

    const p2 = await h.planner.planDay(A, 2);
    expect(p2).not.toBe(p1);
    expect(p2.day).toBe(2);
    expect(h.planner.current(A)).toBe(p2);
  });

  it("advance marks earlier phases done; currentStep tracks the phase", async () => {
    const h = makeHarness();
    await h.planner.planDay(A, 1);
    h.planner.advance(A, "morning");
    expect(h.planner.current(A)!.steps.map((s) => s.done)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    h.planner.advance(A, "evening");
    expect(h.planner.current(A)!.steps.map((s) => s.done)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const step = h.planner.currentStep(A, "evening");
    expect(step?.phase).toBe("evening");
    expect(h.planner.currentStep(A, "night")?.phase).toBe("night");
    expect(h.planner.currentStep("Nobody", "morning")).toBeNull();
    h.planner.advance("Nobody", "evening"); // no plan -> safe no-op
  });
});

describe("live planning (smart tier + defensive coercion)", () => {
  it("uses a valid live plan verbatim (rawText preserved for the inspector)", async () => {
    const raw = JSON.stringify({
      steps: [
        { phase: "morning", goal: "water the east plot" },
        { phase: "afternoon", goal: "harvest parsnips" },
        { phase: "evening", goal: "sell at the shop", targetLandmark: "shop" },
        { phase: "night", goal: "go home and sleep", targetLandmark: "bed" },
      ],
    });
    const h = makeHarness({
      live: true,
      router: async (req) => {
        expect(req.tier).toBe("smart");
        expect(req.user).toContain("I should water more"); // reflections fed in
        expect(req.user).toContain("shop at (19,4)"); // landmarks fed in
        return { raw, model: "live", latencyMs: 1 };
      },
    });
    const plan = await h.planner.planDay(A, 3);
    expect(h.calls).toHaveLength(1);
    expect(plan.rawText).toBe(raw);
    expect(plan.steps.map((s) => s.goal)).toEqual([
      "water the east plot",
      "harvest parsnips",
      "sell at the shop",
      "go home and sleep",
    ]);
    expect(plan.steps[2].targetLandmark).toBe("shop");
  });

  it("coerces partial/misordered live output to exactly 4 phase-ordered steps", () => {
    const raw =
      'Sure! {"steps":[{"phase":"night","goal":"sleep tight","targetLandmark":"bed"},' +
      '{"phase":"morning","goal":"till and plant","targetLandmark":"barn"},' +
      '{"goal":""}]}';
    const steps = coercePlanSteps(raw, "a farmer", 2)!;
    expect(steps.map((s) => s.phase)).toEqual(PHASES);
    expect(steps[0].goal).toBe("till and plant"); // matched by phase name
    expect(steps[0].targetLandmark).toBeUndefined(); // "barn" is not a landmark
    expect(steps[3].goal).toBe("sleep tight");
    expect(steps[1].goal.length).toBeGreaterThan(0); // borrowed from mock plan
    expect(steps[2].goal.length).toBeGreaterThan(0);
  });

  it("falls back to the mock plan on garbage, errors, or goal-free output", async () => {
    const cases: Router[] = [
      async () => ({ raw: "I cannot plan today", model: "live", latencyMs: 1 }),
      async () => ({ raw: "", model: "unknown", latencyMs: 1, error: "boom" }),
      async () => ({ raw: '{"steps":[{"phase":"morning"}]}', model: "live", latencyMs: 1 }),
    ];
    for (const [i, router] of cases.entries()) {
      const h = makeHarness({ live: true, router });
      const plan = await h.planner.planDay(A, i + 1);
      expect(plan.steps.map((s) => s.phase)).toEqual(PHASES);
      expect(plan.steps.every((s) => s.goal.length > 0)).toBe(true);
      expect(h.events.filter((e) => e.kind === "plan_created")).toHaveLength(1);
    }
  });
});
