/**
 * QE v2 — retrieval determinism + the contract scoring math (rule 10):
 *
 *   score = w_rec·decay^hoursSince(lastAccess) + w_imp·importance/10
 *         + w_rel·cosine(queryEmb, memEmb)   (rel = 0 when either emb missing)
 *
 *  - two identically-built stores rank identically for the same query
 *    (replayable runs — no hidden randomness);
 *  - the ranking equals an INDEPENDENT recomputation of the contract
 *    formula (this test implements the math itself rather than trusting
 *    the implementation's helpers);
 *  - retrieve() bumps lastAccess on exactly the returned entries, and
 *    subsequent recency follows the bumped stamp (24h vs 48h decay), per
 *    Park semantics;
 *  - the relevance term is plain cosine and degrades to 0 without vectors.
 */
import { describe, expect, it } from "vitest";
import type { GameStamp, MemoryEntry } from "@contracts/types";
import { gameHours, RETRIEVAL_DEFAULTS } from "@contracts/types";
import { InMemoryMemoryStore } from "../../src/agents/memory/MemoryStore";
import {
  hoursSinceAccess,
  recencyScore,
  scoreMemory,
} from "../../src/agents/memory/retrieval";
import { cosine } from "../../src/llm/embed";

const AGENT = "Tester";

/** Independent implementation of the contract formula (no embeddings). */
function contractScore(m: MemoryEntry, now: GameStamp): number {
  const hours = Math.max(0, gameHours(now) - gameHours(m.lastAccess));
  return 1 * 0.995 ** hours + 1 * (m.importance / 10) + 0;
}

interface Seed {
  text: string;
  importance: number;
  createdAt: GameStamp;
}

const SEEDS: Seed[] = [
  { text: "I tilled the east plot", importance: 2, createdAt: { day: 1, phase: "morning" } },
  { text: "Rusty gave me a parsnip seed", importance: 7, createdAt: { day: 1, phase: "afternoon" } },
  { text: "I talked with Sage about the pond", importance: 5, createdAt: { day: 1, phase: "evening" } },
  { text: "I slept through the night", importance: 2, createdAt: { day: 1, phase: "night" } },
  { text: "my harvest failed at (9,9)", importance: 7, createdAt: { day: 2, phase: "morning" } },
  { text: "I watered the parsnips", importance: 2, createdAt: { day: 2, phase: "afternoon" } },
  { text: "I sold three parsnips at the shop", importance: 4, createdAt: { day: 2, phase: "evening" } },
  { text: "Sage reflected near the well", importance: 9, createdAt: { day: 2, phase: "night" } },
];

async function buildStore(nowRef: { now: GameStamp }): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore({ now: () => nowRef.now, live: () => false });
  for (const s of SEEDS) {
    await store.append({
      agentName: AGENT,
      type: "observation",
      text: s.text,
      importance: s.importance,
      createdAt: s.createdAt,
    });
  }
  return store;
}

describe("retrieval determinism", () => {
  it("two identically-built stores produce the identical ranking for the same query", async () => {
    const nowA = { now: { day: 3, phase: "morning" } as GameStamp };
    const nowB = { now: { day: 3, phase: "morning" } as GameStamp };
    const a = await buildStore(nowA);
    const b = await buildStore(nowB);

    const ra = await a.retrieve(AGENT, "what should I do now", SEEDS.length);
    const rb = await b.retrieve(AGENT, "what should I do now", SEEDS.length);
    expect(ra.map((m) => m.id)).toEqual(rb.map((m) => m.id));
    expect(ra.map((m) => m.id)).toHaveLength(SEEDS.length);

    // ...and a fresh third store agrees again (no order-of-construction drift)
    const nowC = { now: { day: 3, phase: "morning" } as GameStamp };
    const c = await buildStore(nowC);
    const rc = await c.retrieve(AGENT, "completely different query text", SEEDS.length);
    // no embeddings exist, so the query text cannot influence the ranking
    expect(rc.map((m) => m.id)).toEqual(ra.map((m) => m.id));
  });

  it("the ranking equals an independent recomputation of the contract formula", async () => {
    const nowRef = { now: { day: 3, phase: "morning" } as GameStamp };
    const store = await buildStore(nowRef);

    const expected = [...store.all(AGENT)]
      .map((m) => ({ id: m.id, score: contractScore(m, nowRef.now) }))
      .sort((a, b) => b.score - a.score);
    // the seeds were engineered to have strictly distinct scores
    for (let i = 1; i < expected.length; i++) {
      expect(expected[i - 1].score).toBeGreaterThan(expected[i].score);
    }

    const got = await store.retrieve(AGENT, "anything", SEEDS.length);
    expect(got.map((m) => m.id)).toEqual(expected.map((e) => e.id));

    // top-k default is the contract's 5
    expect(RETRIEVAL_DEFAULTS.topK).toBe(5);
    const nowRef2 = { now: { day: 3, phase: "morning" } as GameStamp };
    const store2 = await buildStore(nowRef2);
    const top = await store2.retrieve(AGENT, "anything");
    expect(top.map((m) => m.id)).toEqual(expected.slice(0, 5).map((e) => e.id));
  });

  it("retrieve bumps lastAccess on EXACTLY the returned entries", async () => {
    const nowRef = { now: { day: 3, phase: "morning" } as GameStamp };
    const store = await buildStore(nowRef);

    const before = store.all(AGENT);
    for (const m of before) expect(m.lastAccess).toEqual(m.createdAt);

    const top2 = await store.retrieve(AGENT, "q", 2);
    expect(top2).toHaveLength(2);
    const bumped = new Set(top2.map((m) => m.id));

    for (const m of store.all(AGENT)) {
      if (bumped.has(m.id)) {
        expect(m.lastAccess, `${m.id} bumped`).toEqual({ day: 3, phase: "morning" });
      } else {
        const seed = SEEDS[Number(m.id.split("-m")[1]) - 1];
        expect(m.lastAccess, `${m.id} untouched`).toEqual(seed.createdAt);
      }
    }
  });

  it("subsequent recency follows the bumped stamp exactly as the math says (24h vs 48h)", async () => {
    // Store P gets retrieved at day 2 (bump); store Q is the untouched twin.
    const seeds: Seed[] = [
      { text: "alpha", importance: 9, createdAt: { day: 1, phase: "morning" } },
      { text: "beta", importance: 8, createdAt: { day: 1, phase: "morning" } },
      { text: "gamma", importance: 3, createdAt: { day: 1, phase: "morning" } },
    ];
    const mk = async (nowRef: { now: GameStamp }) => {
      const s = new InMemoryMemoryStore({ now: () => nowRef.now, live: () => false });
      for (const seed of seeds) {
        await s.append({
          agentName: AGENT,
          type: "observation",
          text: seed.text,
          importance: seed.importance,
          createdAt: seed.createdAt,
        });
      }
      return s;
    };
    const nowP = { now: { day: 2, phase: "morning" } as GameStamp };
    const nowQ = { now: { day: 2, phase: "morning" } as GameStamp };
    const p = await mk(nowP);
    const q = await mk(nowQ);

    const bumpedTop = await p.retrieve(AGENT, "q", 2); // bumps alpha+beta in P only
    expect(bumpedTop.map((m) => m.text)).toEqual(["alpha", "beta"]);

    // Advance both clocks to day 3 morning.
    nowP.now = { day: 3, phase: "morning" };
    nowQ.now = { day: 3, phase: "morning" };
    const now: GameStamp = { day: 3, phase: "morning" };

    const pAlpha = p.all(AGENT).find((m) => m.text === "alpha")!;
    const qAlpha = q.all(AGENT).find((m) => m.text === "alpha")!;

    // Bumped: 24 game-hours since access; untouched twin: 48.
    expect(hoursSinceAccess(pAlpha, now)).toBe(24);
    expect(hoursSinceAccess(qAlpha, now)).toBe(48);
    expect(recencyScore(pAlpha, now)).toBe(0.995 ** 24);
    expect(recencyScore(qAlpha, now)).toBe(0.995 ** 48);
    expect(scoreMemory(pAlpha, now, undefined)).toBeGreaterThan(
      scoreMemory(qAlpha, now, undefined),
    );
    // ...and the full scores match the independent formula to the bit.
    expect(scoreMemory(pAlpha, now, undefined)).toBe(contractScore(pAlpha, now));
    expect(scoreMemory(qAlpha, now, undefined)).toBe(contractScore(qAlpha, now));

    // The next ranking in P still matches the recomputed math on the
    // CURRENT lastAccess values (bump semantics, not creation order).
    const expectedP = [...p.all(AGENT)]
      .map((m) => ({ id: m.id, score: contractScore(m, now) }))
      .sort((a, b) => b.score - a.score)
      .map((e) => e.id);
    const gotP = await p.retrieve(AGENT, "q", 3);
    expect(gotP.map((m) => m.id)).toEqual(expectedP);
  });

  it("relevance term: plain cosine when both vectors exist, 0 otherwise", () => {
    const now: GameStamp = { day: 1, phase: "morning" };
    const base: Omit<MemoryEntry, "id" | "embedding"> = {
      agentName: AGENT,
      type: "observation",
      text: "x",
      importance: 5,
      createdAt: now,
      lastAccess: now,
    };
    const withEmb: MemoryEntry = { ...base, id: "t-m1", embedding: [1, 0] };
    const noEmb: MemoryEntry = { ...base, id: "t-m2" };

    // identical recency+importance; only the relevance term differs
    const query = [1, 0];
    expect(scoreMemory(withEmb, now, query) - scoreMemory(noEmb, now, query)).toBeCloseTo(
      1,
      12, // cosine([1,0],[1,0]) === 1
    );
    const orthogonal: MemoryEntry = { ...base, id: "t-m3", embedding: [0, 1] };
    expect(scoreMemory(orthogonal, now, query)).toBe(scoreMemory(noEmb, now, query));

    // no query embedding -> the term vanishes even when the memory has one
    expect(scoreMemory(withEmb, now, undefined)).toBe(scoreMemory(noEmb, now, undefined));

    // cosine degenerate cases score as "no relevance" per the contract
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 0], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
