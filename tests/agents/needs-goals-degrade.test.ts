/**
 * Wave 3a degrade test — the needs/goal layer must survive a hostile live
 * router. With the smart-tier goal call ALWAYS erroring, a full decision +
 * day-advance cycle still completes: agent.goal becomes non-null (mock
 * fallback), obs.self.needs is present, and no unhandled rejection escapes
 * into the decision loop (rule 10). $0 — the decision router is the heuristic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, Router, Vec2 } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { FIELD_RECT } from "../../src/world/map";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { runDecisionCycle } from "../../src/agents/AgentRuntime";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

const POS: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 + 1 };

function makeAgent(pos: Vec2, name: string): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: `${name} — a test farmer`,
    color: 0xffffff,
    start: pos,
  });
}

function routerOf(action: AgentAction): Router {
  return async () => ({ raw: JSON.stringify(action), parsed: action, model: "stub", latencyMs: 1 });
}

/** A cognition LLM router that ALWAYS errors (planner + goal smart calls). */
const ALWAYS_ERROR: Router = async () => ({
  raw: "",
  model: "broken",
  latencyMs: 0,
  error: "simulated upstream failure",
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

let unhandled: unknown[] = [];
function onUnhandled(e: PromiseRejectionEvent | { reason?: unknown }) {
  unhandled.push((e as { reason?: unknown }).reason ?? e);
}

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

describe("needs/goal degrade under an always-erroring live router", () => {
  it("a full cycle completes with a mock goal, present needs, and no unhandled rejection", async () => {
    const cognition = new CognitionSystem({
      bus: getEventBus(),
      live: () => true, // force the LIVE goal/plan path
      router: ALWAYS_ERROR, // ...which always fails → mock fallback
    });
    const a = makeAgent({ ...POS }, "Alice");
    cognition.registerAgent(a);

    // Morning cadence: forces a goal refresh + plan pre-warm (both go live → error → mock).
    cognition.onDayAdvanced();
    await flush();

    // A decision cycle: the decision router stays the deterministic heuristic.
    await runDecisionCycle(a, {
      world: getWorld(),
      agents: [a],
      bus: getEventBus(),
      router: routerOf({ thought: "t", say: null, action: "WAIT" }),
      cognition,
    });
    await flush();

    // Goal synthesized via the mock fallback — never left null.
    expect(a.goal).not.toBeNull();
    expect(typeof a.goal).toBe("string");
    expect((a.goal as string).length).toBeGreaterThan(0);

    // Needs vector present on the agent and in the serialized observation.
    expect(a.needs).not.toBeNull();
    const obs = JSON.parse(a.trace[0].observationJson);
    expect(obs.self.needs).toBeDefined();
    for (const k of ["energy", "wealth", "social", "novelty", "purpose"] as const) {
      expect(typeof obs.self.needs[k]).toBe("number");
      expect(obs.self.needs[k]).toBeGreaterThanOrEqual(0);
      expect(obs.self.needs[k]).toBeLessThanOrEqual(1);
    }

    await flush();
    expect(unhandled).toEqual([]);
  });
});
