/**
 * GoalsSystem (Wave 3a) — needs-driven standing-goal synthesis.
 *
 * Covers: mock keyword per dominant drive, determinism + cross-persona
 * variety, the cadence gate (cache hit never re-derives; force re-derives;
 * a threshold-cross into a NEW dominant drive re-derives), the live path
 * (good → cached / error → mockGoal fallback / throw → no-throw), and the
 * per-(agent,day) inflight idempotency. Pure-model: no Phaser, real LLM never
 * called (router is a stub).
 */
import { describe, expect, it, vi } from "vitest";
import type { GameStamp, NeedState, Router } from "@contracts/types";
import { GoalsSystem } from "../../src/agents/Goals";
import { mockGoal } from "../../src/llm/mock";

const BASE: NeedState = { energy: 0, wealth: 0.5, social: 0.3, novelty: 0.3, purpose: 0.5 };

function makeDeps(over: Partial<{
  live: boolean;
  router: Router;
  stamp: GameStamp;
  needs: NeedState;
  persona: string;
  memories: string[];
  onLiveCall: () => void;
}> = {}) {
  const stampRef = { v: over.stamp ?? ({ day: 1, phase: "morning" } as GameStamp) };
  const needsRef = { v: over.needs ?? { ...BASE } };
  return {
    stampRef,
    needsRef,
    deps: {
      live: () => over.live ?? false,
      router:
        over.router ??
        (async () => ({ raw: "", model: "none", latencyMs: 0, error: "no router" })),
      now: () => stampRef.v,
      persona: () => over.persona ?? "a hardworking farmer",
      needs: () => ({ ...needsRef.v }),
      topMemories: () => over.memories ?? [],
      ...(over.onLiveCall ? { onLiveCall: over.onLiveCall } : {}),
    },
  };
}

describe("mock goal — keyword per dominant drive", () => {
  it("each dominant drive yields a goal with plan-follower keywords", async () => {
    const cases: [keyof NeedState, RegExp][] = [
      ["energy", /rest|sleep|home|recover/i],
      ["wealth", /sell|market|haggle|coin|saving/i],
      ["social", /sociali|tavern|chat|company/i],
      ["novelty", /wander|stroll|explore/i],
      ["purpose", /till|plant|water|farm|crop|seed/i],
    ];
    for (const [drive, re] of cases) {
      const needs: NeedState = { energy: 0, wealth: 0, social: 0, novelty: 0, purpose: 0 };
      needs[drive] = 0.95;
      const { deps } = makeDeps({ needs });
      const goals = new GoalsSystem(deps);
      const g = await goals.refresh("A", { force: true });
      expect(g, `drive=${drive} goal="${g}"`).toMatch(re);
    }
  });
});

describe("determinism + cross-persona variety", () => {
  it("same persona + day + drives → identical goal", () => {
    const needs: NeedState = { energy: 0, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    expect(mockGoal("Social Sam", needs, 2)).toBe(mockGoal("Social Sam", needs, 2));
  });

  it("different personas can produce different phrasings of the same drive", () => {
    const needs: NeedState = { energy: 0, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    const phrasings = new Set(
      ["Sam", "Dora", "Wren", "Fern", "Moss", "Rusty"].map((p) => mockGoal(p, needs, 5)),
    );
    // The social template bank has multiple phrasings; across 6 personas at
    // least two distinct strings should appear (variety, not a constant).
    expect(phrasings.size).toBeGreaterThan(1);
  });
});

describe("cadence gate", () => {
  it("current() is null until the first refresh resolves", async () => {
    const { deps } = makeDeps();
    const goals = new GoalsSystem(deps);
    expect(goals.current("A")).toBeNull();
    await goals.refresh("A", { force: true });
    expect(goals.current("A")).not.toBeNull();
  });

  it("a cache hit (same day, no force, no threshold-cross) never re-derives", async () => {
    const router = vi.fn<Router>(async () => ({ raw: "", model: "none", latencyMs: 0, error: "e" }));
    const { deps } = makeDeps({ live: true, router });
    const goals = new GoalsSystem(deps);
    await goals.refresh("A", { force: true });
    const calls = router.mock.calls.length;
    const cached = goals.current("A");
    // No force, no threshold-cross → returns the cache without a router call.
    const again = await goals.refresh("A");
    expect(again).toBe(cached);
    expect(router.mock.calls.length).toBe(calls);
  });

  it("force re-derives even on the same day", async () => {
    const router = vi.fn<Router>(async () => ({ raw: "", model: "none", latencyMs: 0, error: "e" }));
    const { deps } = makeDeps({ live: true, router });
    const goals = new GoalsSystem(deps);
    await goals.refresh("A", { force: true });
    const calls = router.mock.calls.length;
    await goals.refresh("A", { force: true });
    expect(router.mock.calls.length).toBe(calls + 1);
  });

  it("a threshold-cross into a NEW dominant drive re-derives", async () => {
    const needs: NeedState = { energy: 0, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    const { deps, needsRef } = makeDeps({ needs });
    const goals = new GoalsSystem(deps);
    const first = await goals.refresh("A", { force: true }); // drivenBy=social
    expect(first).toMatch(/sociali|tavern|chat|company/i);
    // A new drive crosses 0.75 and becomes dominant → re-derive (no force).
    needsRef.v = { energy: 0.96, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    const second = await goals.refresh("A");
    expect(second).toMatch(/rest|sleep|home|recover/i);
    expect(second).not.toBe(first);
  });

  it("a sub-threshold wiggle in a non-dominant drive does NOT re-derive", async () => {
    const needs: NeedState = { energy: 0, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    const { deps, needsRef } = makeDeps({ needs });
    const goals = new GoalsSystem(deps);
    const first = await goals.refresh("A", { force: true });
    // novelty rises but stays below 0.75 → still social-dominant → cache hit.
    needsRef.v = { energy: 0, wealth: 0, social: 0.95, novelty: 0.5, purpose: 0 };
    expect(await goals.refresh("A")).toBe(first);
  });
});

describe("live path", () => {
  it("a good live line is sanitized + cached", async () => {
    const router: Router = async () => ({
      raw: "  Save up enough gold to expand the farm.  \n",
      model: "smart",
      latencyMs: 5,
    });
    const onLiveCall = vi.fn();
    const { deps } = makeDeps({ live: true, router, onLiveCall });
    const goals = new GoalsSystem(deps);
    const g = await goals.refresh("A", { force: true });
    expect(g).toBe("Save up enough gold to expand the farm.");
    expect(onLiveCall).toHaveBeenCalledTimes(1);
    expect(goals.current("A")).toBe(g);
  });

  it("a router error falls back to the deterministic mockGoal", async () => {
    const router: Router = async () => ({ raw: "", model: "x", latencyMs: 0, error: "429" });
    const needs: NeedState = { energy: 0, wealth: 0, social: 0.95, novelty: 0, purpose: 0 };
    const { deps } = makeDeps({ live: true, router, needs, persona: "Sam" });
    const goals = new GoalsSystem(deps);
    const g = await goals.refresh("A", { force: true });
    expect(g).toBe(mockGoal("Sam", needs, 1));
  });

  it("an over-long live line falls back to mockGoal", async () => {
    const router: Router = async () => ({ raw: "x".repeat(800), model: "smart", latencyMs: 1 });
    const needs: NeedState = { energy: 0, wealth: 0, social: 0, novelty: 0, purpose: 0.95 };
    const { deps } = makeDeps({ live: true, router, needs, persona: "Dora" });
    const goals = new GoalsSystem(deps);
    const g = await goals.refresh("A", { force: true });
    expect(g).toBe(mockGoal("Dora", needs, 1));
  });

  it("an empty live line falls back to mockGoal", async () => {
    const router: Router = async () => ({ raw: "   \n  ", model: "smart", latencyMs: 1 });
    const needs: NeedState = { energy: 0, wealth: 0.95, social: 0, novelty: 0, purpose: 0 };
    const { deps } = makeDeps({ live: true, router, needs, persona: "Fern" });
    const goals = new GoalsSystem(deps);
    expect(await goals.refresh("A", { force: true })).toBe(mockGoal("Fern", needs, 1));
  });

  it("a throwing router never throws out of refresh()", async () => {
    const router: Router = async () => {
      throw new Error("boom");
    };
    const { deps } = makeDeps({ live: true, router, persona: "Rusty" });
    const goals = new GoalsSystem(deps);
    const g = await goals.refresh("A", { force: true }); // resolves, never rejects
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
  });
});

describe("inflight idempotency", () => {
  it("concurrent same-day refreshes share ONE router call", async () => {
    let resolveCall!: () => void;
    const gate = new Promise<void>((r) => (resolveCall = r));
    const router = vi.fn<Router>(async () => {
      await gate;
      return { raw: "Tend the farm and prosper.", model: "smart", latencyMs: 1 };
    });
    const { deps } = makeDeps({ live: true, router });
    const goals = new GoalsSystem(deps);
    const p1 = goals.refresh("A", { force: true });
    const p2 = goals.refresh("A", { force: true });
    resolveCall();
    const [g1, g2] = await Promise.all([p1, p2]);
    expect(g1).toBe(g2);
    expect(router.mock.calls.length).toBe(1);
  });
});
