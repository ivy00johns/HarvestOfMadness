/**
 * ReflectionEngine (rule 11) — threshold trigger at 30 summed observation
 * importance, sourceIds citation, defensive live parsing with mock fallback,
 * per-day cadence cap, and the "reflection" event.
 */
import { describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  LlmRequest,
  MemoryEntry,
  Router,
  WorldEvent,
} from "@contracts/types";
import { REFLECTION_IMPORTANCE_THRESHOLD } from "@contracts/types";
import { InMemoryMemoryStore } from "../../src/agents/memory/MemoryStore";
import {
  MAX_REFLECTIONS_PER_DAY,
  REFLECTION_IMPORTANCE,
  ReflectionEngineImpl,
} from "../../src/agents/Reflection";
import {
  extractFirstJsonArray,
  parseInsights,
  parseStringArray,
} from "../../src/agents/llmJson";

const A = "Tester";

function makeBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => {
      events.push({ ...e, seq: ++seq, ts: Date.now() });
    },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

interface Harness {
  store: InMemoryMemoryStore;
  engine: ReflectionEngineImpl;
  events: WorldEvent[];
  now: { stamp: GameStamp };
  calls: LlmRequest[];
}

function makeHarness(opts: { live?: boolean; router?: Router } = {}): Harness {
  const now = { stamp: { day: 1, phase: "morning" } as GameStamp };
  const store = new InMemoryMemoryStore({ now: () => now.stamp });
  const { bus, events } = makeBus();
  const calls: LlmRequest[] = [];
  const router: Router = async (req) => {
    calls.push(req);
    return opts.router
      ? opts.router(req)
      : { raw: "", model: "none", latencyMs: 0, error: "no router" };
  };
  const engine = new ReflectionEngineImpl({
    store,
    write: async (agentName, text, importance, sourceIds) =>
      store.append({
        agentName,
        type: "reflection",
        text,
        importance,
        createdAt: now.stamp,
        ...(sourceIds.length > 0 ? { sourceIds } : {}),
      }),
    bus,
    live: () => opts.live ?? false,
    router,
    now: () => now.stamp,
  });
  return { store, engine, events, now, calls };
}

async function seedObservations(
  h: Harness,
  count: number,
  importance: number,
): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await h.store.append({
        agentName: A,
        type: "observation",
        text: `event number ${i}`,
        importance,
        createdAt: h.now.stamp,
      }),
    );
  }
  return out;
}

describe("threshold trigger", () => {
  it("is a no-op below REFLECTION_IMPORTANCE_THRESHOLD", async () => {
    const h = makeHarness();
    await seedObservations(h, 5, 5); // 25 < 30
    expect(await h.engine.maybeReflect(A)).toEqual([]);
    expect(h.events.filter((e) => e.kind === "reflection")).toHaveLength(0);
  });

  it("fires at >= 30 summed importance, stores a cited reflection, resets the sum", async () => {
    const h = makeHarness();
    const seeds = await seedObservations(h, 6, 5); // 30 == threshold
    expect(h.store.importanceSinceReflection(A)).toBe(
      REFLECTION_IMPORTANCE_THRESHOLD,
    );

    const out = await h.engine.maybeReflect(A);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("reflection");
    expect(out[0].importance).toBe(REFLECTION_IMPORTANCE);
    // sourceIds cite real memories
    expect(out[0].sourceIds!.length).toBeGreaterThan(0);
    const known = new Set(seeds.map((m) => m.id));
    for (const id of out[0].sourceIds!) expect(known.has(id)).toBe(true);
    // the reflection append reset the accumulator
    expect(h.store.importanceSinceReflection(A)).toBe(0);
    // and the event went out with insightIds
    const evts = h.events.filter((e) => e.kind === "reflection");
    expect(evts).toHaveLength(1);
    expect(evts[0].agentName).toBe(A);
    expect(evts[0].payload?.insightIds).toEqual([out[0].id]);
    // immediately after, the trigger is re-armed (no double fire)
    expect(await h.engine.maybeReflect(A)).toEqual([]);
  });

  it("caps reflections per game-day, and the cap resets next day", async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_REFLECTIONS_PER_DAY; i++) {
      await seedObservations(h, 6, 5);
      expect(await h.engine.maybeReflect(A)).toHaveLength(1);
    }
    await seedObservations(h, 6, 5);
    expect(await h.engine.maybeReflect(A)).toEqual([]); // capped
    h.now.stamp = { day: 2, phase: "morning" };
    expect((await h.engine.maybeReflect(A)).length).toBe(1); // re-armed
  });
});

describe("live path (smart tier, defensive parsing)", () => {
  it("questions -> retrieve -> insights, each insight stored with filtered sourceIds", async () => {
    let phase = 0;
    let seedIds: string[] = [];
    const router: Router = async (req) => {
      expect(req.tier).toBe("smart");
      phase++;
      if (phase === 1) {
        return {
          raw: '["What is happening with the harvest?","q2","q3"]',
          model: "live",
          latencyMs: 1,
        };
      }
      // cite one real id, one fake (must be filtered out)
      return {
        raw: `Here you go: [{"insight":"The harvest is going well","sourceIds":["${seedIds[0]}","ghost-m99"]},{"insight":"Gus likes me","sourceIds":["${seedIds[1]}"]}]`,
        model: "live",
        latencyMs: 1,
      };
    };
    const h = makeHarness({ live: true, router });
    seedIds = (await seedObservations(h, 6, 5)).map((m) => m.id);

    const out = await h.engine.maybeReflect(A);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("The harvest is going well");
    expect(out[0].sourceIds).toEqual([seedIds[0]]); // ghost id filtered
    expect(out[1].sourceIds).toEqual([seedIds[1]]);
    expect(h.calls).toHaveLength(2); // exactly 2 smart calls per reflection

    const evt = h.events.find((e) => e.kind === "reflection");
    expect(evt?.payload?.questions).toEqual([
      "What is happening with the harvest?",
      "q2",
      "q3",
    ]);
    expect(evt?.payload?.insightIds).toEqual(out.map((m) => m.id));
  });

  it("garbage live responses degrade to the mock reflection (never empty-handed)", async () => {
    const router: Router = async () => ({
      raw: "I refuse to answer in JSON",
      model: "live",
      latencyMs: 1,
    });
    const h = makeHarness({ live: true, router });
    await seedObservations(h, 6, 5);
    const out = await h.engine.maybeReflect(A);
    expect(out).toHaveLength(1); // mock fallback insight
    expect(out[0].type).toBe("reflection");
    expect(out[0].sourceIds!.length).toBeGreaterThan(0);
  });

  it("router errors degrade to the mock reflection too", async () => {
    const router: Router = async () => ({
      raw: "",
      model: "unknown",
      latencyMs: 1,
      error: "upstream_error: 502",
    });
    const h = makeHarness({ live: true, router });
    await seedObservations(h, 6, 5);
    expect(await h.engine.maybeReflect(A)).toHaveLength(1);
  });
});

describe("defensive JSON extraction (cognition responses)", () => {
  it("extractFirstJsonArray is fence/prose/string-aware", () => {
    expect(extractFirstJsonArray('```json\n["a","b"]\n```')).toBe('["a","b"]');
    expect(extractFirstJsonArray('noise ["x]", "y"] tail')).toBe('["x]", "y"]');
    expect(extractFirstJsonArray("no array here")).toBeNull();
    expect(extractFirstJsonArray("[1, 2")).toBeNull(); // unbalanced
  });

  it("parseStringArray filters non-strings and caps", () => {
    expect(parseStringArray('["a", 2, "", "b", "c", "d"]', 3)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(parseStringArray("not json")).toEqual([]);
  });

  it("parseInsights drops junk entries, filters unknown ids, caps at max", () => {
    const known = new Set(["m1", "m2"]);
    const raw =
      '[{"insight":"one","sourceIds":["m1","zzz"]},{"sourceIds":["m2"]},' +
      '{"insight":"  "},{"insight":"two","sourceIds":"m2"},{"insight":"three"}]';
    expect(parseInsights(raw, known, 2)).toEqual([
      { insight: "one", sourceIds: ["m1"] },
      { insight: "two", sourceIds: [] },
    ]);
  });
});
