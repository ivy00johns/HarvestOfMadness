/**
 * MemoryStore + retrieval scoring (contracts v2, rule 10) — exact formula
 * math (decay/importance/relevance), lastAccess bump semantics, the
 * missing-embedding degradation path, fire-and-forget embedding writes, and
 * importanceSinceReflection accounting. Plus the importance rater's
 * heuristic-first / hint / live-fast-tier / fallback ladder.
 */
import { describe, expect, it, vi } from "vitest";
import type { GameStamp, LlmRequest, MemoryEntry, Router } from "@contracts/types";
import { gameHours, RETRIEVAL_DEFAULTS } from "@contracts/types";
import { cosine } from "../../src/llm/embed";
import {
  hoursSinceAccess,
  recencyScore,
  scoreMemory,
} from "../../src/agents/memory/retrieval";
import { InMemoryMemoryStore } from "../../src/agents/memory/MemoryStore";
import {
  clampImportance,
  parseImportanceInt,
  rateImportance,
} from "../../src/agents/memory/importance";

const A = "Tester";

function stamp(day: number, phase: GameStamp["phase"] = "morning"): GameStamp {
  return { day, phase };
}

function obsInput(text: string, importance: number, createdAt: GameStamp) {
  return { agentName: A, type: "observation" as const, text, importance, createdAt };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("scoring math (contract formula)", () => {
  const base: MemoryEntry = {
    id: "Tester-m1",
    agentName: A,
    type: "observation",
    text: "I watered the crop at (9,8)",
    importance: 4,
    createdAt: stamp(1),
    lastAccess: stamp(1),
  };

  it("recency decays at decay^gameHours since lastAccess", () => {
    const now = stamp(2); // 24 game-hours after day-1 morning
    expect(hoursSinceAccess(base, now)).toBe(24);
    expect(recencyScore(base, now)).toBeCloseTo(0.995 ** 24, 12);
    // same-stamp access = decay^0 = 1
    expect(recencyScore(base, stamp(1))).toBe(1);
    // phases are 6 game-hours apart
    expect(hoursSinceAccess(base, { day: 1, phase: "evening" })).toBe(12);
  });

  it("score = w·decay^h + w·importance/10 + w·cosine, equal weights", () => {
    const emb = [1, 0];
    const queryEmb = [Math.SQRT1_2, Math.SQRT1_2]; // cosine 0.7071
    const entry: MemoryEntry = { ...base, embedding: emb };
    const now = stamp(2);
    const expected =
      1 * 0.995 ** 24 + 1 * (4 / 10) + 1 * cosine(queryEmb, emb);
    expect(scoreMemory(entry, now, queryEmb)).toBeCloseTo(expected, 12);
  });

  it("relevance term is 0 when EITHER embedding is missing (rule 10)", () => {
    const now = stamp(2);
    const noRel = 0.995 ** 24 + 0.4;
    // memory unembedded
    expect(scoreMemory(base, now, [1, 0])).toBeCloseTo(noRel, 12);
    // query unembedded
    expect(scoreMemory({ ...base, embedding: [1, 0] }, now, undefined)).toBeCloseTo(
      noRel,
      12,
    );
  });

  it("honors custom weights/decay", () => {
    const cfg = {
      ...RETRIEVAL_DEFAULTS,
      decay: 0.9,
      weights: { recency: 2, importance: 0.5, relevance: 0 },
    };
    const now = stamp(1, "afternoon"); // 6 hours
    expect(scoreMemory(base, now, [1, 0], cfg)).toBeCloseTo(
      2 * 0.9 ** 6 + 0.5 * 0.4,
      12,
    );
  });
});

describe("InMemoryMemoryStore", () => {
  it("append assigns per-agent ${name}-m${counter} ids and lastAccess=createdAt", async () => {
    const store = new InMemoryMemoryStore({ now: () => stamp(1) });
    const e1 = await store.append(obsInput("first", 2, stamp(1)));
    const e2 = await store.append(obsInput("second", 2, stamp(1, "evening")));
    const other = await store.append({ ...obsInput("x", 2, stamp(1)), agentName: "B" });
    expect(e1.id).toBe("Tester-m1");
    expect(e2.id).toBe("Tester-m2");
    expect(other.id).toBe("B-m1");
    expect(e2.lastAccess).toEqual(e2.createdAt);
    expect(e2.lastAccess).not.toBe(e2.createdAt); // copied, not aliased
    expect(store.all(A)).toHaveLength(2);
    // entries work without embeddings (mock mode: no embed request at all)
    expect(e1.embedding).toBeUndefined();
  });

  it("requests embeddings fire-and-forget in live mode; failure never surfaces", async () => {
    const embedded = new InMemoryMemoryStore({
      now: () => stamp(1),
      live: () => true,
      embed: async (texts) => texts.map(() => [1, 0]),
    });
    const ok = await embedded.append(obsInput("water the crops", 2, stamp(1)));
    await flush(); // append never waits on the embedding — it lands later
    expect(ok.embedding).toEqual([1, 0]);

    const failing = new InMemoryMemoryStore({
      now: () => stamp(1),
      live: () => true,
      embed: async () => {
        throw new Error("endpoint down");
      },
    });
    const e = await failing.append(obsInput("still fine", 2, stamp(1)));
    await flush();
    expect(e.embedding).toBeUndefined(); // degraded, not broken
  });

  it("retrieve ranks by the full score and bumps lastAccess on returned entries only", async () => {
    let now = stamp(1);
    const store = new InMemoryMemoryStore({ now: () => now });
    const old = await store.append(obsInput("old routine", 2, stamp(1)));
    now = stamp(3);
    const recent = await store.append(obsInput("recent routine", 2, stamp(3)));
    const poignant = await store.append({
      ...obsInput("Gus gave me a gift", 7, stamp(1)),
    });

    now = stamp(3, "afternoon");
    const top2 = await store.retrieve(A, "anything", 2);
    // importance 7 wins; then the recent one beats the 54-hour-old one.
    expect(top2.map((m) => m.id)).toEqual([poignant.id, recent.id]);
    // lastAccess bumped on returned entries, untouched on the rest
    expect(poignant.lastAccess).toEqual(stamp(3, "afternoon"));
    expect(recent.lastAccess).toEqual(stamp(3, "afternoon"));
    expect(old.lastAccess).toEqual(stamp(1));
  });

  it("the lastAccess bump feeds back into later recency scores", async () => {
    let now = stamp(1);
    const store = new InMemoryMemoryStore({ now: () => now });
    const a = await store.append(obsInput("alpha", 2, stamp(1)));
    await store.append(obsInput("beta", 2, stamp(1)));

    now = stamp(4);
    const [first] = await store.retrieve(A, "q", 1);
    // tie on score -> newest createdAt, then id order: alpha (m1) vs beta
    // (m2) have identical stamps, so id tiebreak gives alpha-m1... ids are
    // Tester-m1 < Tester-m2 lexicographically -> m1 returned.
    expect(first.id).toBe(a.id);
    // a was just accessed; b still has day-1 lastAccess -> recency differs.
    expect(hoursSinceAccess(first, now)).toBe(0);
    const again = await store.retrieve(A, "q", 1);
    expect(again[0].id).toBe(a.id); // refreshed recency keeps it on top
  });

  it("uses the query embedding for relevance when memories are embedded", async () => {
    const vecs: Record<string, number[]> = {
      "watering chores": [1, 0],
      "shopping spree": [0, 1],
      "water the crops": [0.9, Math.sqrt(1 - 0.81)],
    };
    const store = new InMemoryMemoryStore({
      now: () => stamp(1),
      live: () => true,
      embed: async (texts) => texts.map((t) => vecs[t] ?? [0, 0]),
    });
    await store.append(obsInput("watering chores", 2, stamp(1)));
    await store.append(obsInput("shopping spree", 2, stamp(1)));
    await flush(); // let the memory embeddings land

    const top = await store.retrieve(A, "water the crops", 1);
    expect(top[0].text).toBe("watering chores"); // relevance broke the tie
  });

  it("never blocks retrieval on a hung embeddings endpoint (time-bounded)", async () => {
    const store = new InMemoryMemoryStore({
      now: () => stamp(1),
      live: () => true,
      embed: () => new Promise(() => {}), // hangs forever
      queryEmbedWaitMs: 20,
    });
    const e = await store.append(obsInput("solo", 5, stamp(1)));
    e.embedding = [1, 0]; // force "an embedding exists" so the query path runs
    const out = await store.retrieve(A, "query", 5);
    expect(out.map((m) => m.id)).toEqual([e.id]); // resolved despite the hang
  });

  it("defaults to top-5 and returns [] for unknown agents", async () => {
    const store = new InMemoryMemoryStore({ now: () => stamp(1) });
    for (let i = 0; i < 8; i++) {
      await store.append(obsInput(`m${i}`, 2, stamp(1)));
    }
    expect(await store.retrieve(A, "q")).toHaveLength(5);
    expect(await store.retrieve("Nobody", "q")).toEqual([]);
  });

  it("importanceSinceReflection sums observations and resets on reflection", async () => {
    const store = new InMemoryMemoryStore({ now: () => stamp(1) });
    expect(store.importanceSinceReflection(A)).toBe(0);
    await store.append(obsInput("one", 5, stamp(1)));
    await store.append(obsInput("two", 7, stamp(1)));
    expect(store.importanceSinceReflection(A)).toBe(12);
    // plans neither add nor reset
    await store.append({ ...obsInput("plan", 4, stamp(1)), type: "plan" });
    expect(store.importanceSinceReflection(A)).toBe(12);
    await store.append({ ...obsInput("insight", 6, stamp(1)), type: "reflection" });
    expect(store.importanceSinceReflection(A)).toBe(0);
    await store.append(obsInput("three", 2, stamp(1)));
    expect(store.importanceSinceReflection(A)).toBe(2);
  });
});

describe("importance rating ladder", () => {
  const neverRouter: Router = vi.fn(async () => {
    throw new Error("must not be called");
  });

  it("heuristic-classified texts never reach the LLM (budget rule)", async () => {
    const deps = { live: () => true, router: neverRouter };
    expect(await rateImportance("Gus gave me a gift", undefined, deps)).toBe(7);
    expect(await rateImportance("I talked with Fern", undefined, deps)).toBe(5);
    expect(await rateImportance("I watered the crop", undefined, deps)).toBe(2);
    expect(neverRouter).not.toHaveBeenCalled();
  });

  it("unclassified + hint -> hint, no call; mock mode -> heuristic default", async () => {
    const deps = { live: () => true, router: neverRouter };
    expect(await rateImportance("something odd happened", 4, deps)).toBe(4);
    expect(
      await rateImportance("something odd happened", undefined, {
        live: () => false,
        router: neverRouter,
      }),
    ).toBe(3);
    expect(neverRouter).not.toHaveBeenCalled();
  });

  it("live + unclassified + no hint -> ONE fast-tier call, parsed defensively", async () => {
    const calls: LlmRequest[] = [];
    const router: Router = async (req) => {
      calls.push(req);
      return { raw: "I'd rate this an 8 out of 10", model: "live", latencyMs: 1 };
    };
    const n = await rateImportance("something odd happened", undefined, {
      live: () => true,
      router,
    });
    expect(n).toBe(8);
    expect(calls).toHaveLength(1);
    expect(calls[0].tier).toBe("fast");
    expect(calls[0].user).toContain("something odd happened");
  });

  it("garbage / error / thrown live responses fall back to the heuristic", async () => {
    const garbage: Router = async () => ({ raw: "no numbers here", model: "m", latencyMs: 1 });
    const errored: Router = async () => ({ raw: "", model: "m", latencyMs: 1, error: "boom" });
    const throwing: Router = async () => {
      throw new Error("kaput");
    };
    for (const router of [garbage, errored, throwing]) {
      expect(
        await rateImportance("something odd happened", undefined, {
          live: () => true,
          router,
        }),
      ).toBe(3);
    }
  });

  it("parseImportanceInt clamps to 1-10 and rejects integer-free text", () => {
    expect(parseImportanceInt("7")).toBe(7);
    expect(parseImportanceInt("rating: 42!")).toBe(10);
    expect(parseImportanceInt("-3")).toBe(1);
    expect(parseImportanceInt("none")).toBeNull();
    expect(clampImportance(0.4)).toBe(1);
    expect(clampImportance(11)).toBe(10);
  });
});

describe("gameHours sanity (contract helper this module leans on)", () => {
  it("counts 6h per phase from day-1 morning", () => {
    expect(gameHours(stamp(1))).toBe(0);
    expect(gameHours({ day: 1, phase: "night" })).toBe(18);
    expect(gameHours(stamp(3))).toBe(48);
  });
});
