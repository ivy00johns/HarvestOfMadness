/**
 * RelationshipStore (AGA pattern) — AFFINITY_DELTAS application, ±100 clamp,
 * asymmetry, lazy once-per-day-per-pair summary refresh (mock template +
 * live one-liner), relationship_updated events, topFor feed.
 */
import { describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  LlmRequest,
  Router,
  WorldEvent,
} from "@contracts/types";
import { AFFINITY_DELTAS } from "@contracts/types";
import {
  AFFINITY_MAX,
  clampAffinity,
  RelationshipStoreImpl,
  sanitizeOneLiner,
  templateSummary,
} from "../../src/agents/Relationships";

interface Harness {
  store: RelationshipStoreImpl;
  events: WorldEvent[];
  calls: LlmRequest[];
  now: { stamp: GameStamp };
  changed: string[];
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
  const calls: LlmRequest[] = [];
  const now = { stamp: { day: 1, phase: "morning" } as GameStamp };
  const changed: string[] = [];
  const store = new RelationshipStoreImpl({
    bus,
    live: () => opts.live ?? false,
    router: async (req) => {
      calls.push(req);
      return opts.router
        ? opts.router(req)
        : { raw: "", model: "none", latencyMs: 0, error: "no router" };
    },
    now: () => now.stamp,
    persona: () => "a warm chatty farmer",
    onChange: (name) => changed.push(name),
  });
  return { store, events, calls, now, changed };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("affinity deltas + clamp", () => {
  it("TALK_TO +2, GIVE_GIFT +10, interactions counted", () => {
    const h = makeHarness();
    h.store.recordInteraction("A", "B", "TALK_TO", "hello");
    expect(h.store.get("A", "B")).toMatchObject({
      agentName: "A",
      otherName: "B",
      affinity: AFFINITY_DELTAS.TALK_TO,
      interactions: 1,
    });
    h.store.recordInteraction("A", "B", "GIVE_GIFT", "they gave me 1 crop:parsnip");
    expect(h.store.get("A", "B")).toMatchObject({ affinity: 12, interactions: 2 });
  });

  it("clamps at +100 and the helper clamps both ends", () => {
    const h = makeHarness();
    for (let i = 0; i < 15; i++) {
      h.store.recordInteraction("A", "B", "GIVE_GIFT", "they gave me 1 crop:parsnip");
    }
    expect(h.store.get("A", "B")!.affinity).toBe(AFFINITY_MAX);
    expect(clampAffinity(-250)).toBe(-100);
    expect(clampAffinity(250)).toBe(100);
  });

  it("is asymmetric: A->B and B->A are independent rows; self-rows refused", () => {
    const h = makeHarness();
    h.store.recordInteraction("A", "B", "TALK_TO", "hello");
    expect(h.store.get("A", "B")!.affinity).toBe(2);
    expect(h.store.get("B", "A")).toBeNull();
    h.store.recordInteraction("B", "A", "GIVE_GIFT", "I gave them 1 crop:potato");
    expect(h.store.get("B", "A")!.affinity).toBe(10);
    expect(h.store.get("A", "B")!.affinity).toBe(2); // untouched
    h.store.recordInteraction("A", "A", "TALK_TO", "talking to myself");
    expect(h.store.get("A", "A")).toBeNull();
    expect(h.store.allFor("A").map((r) => r.otherName)).toEqual(["B"]);
  });

  it("emits relationship_updated with {otherName, affinity, delta} per interaction", () => {
    const h = makeHarness();
    h.store.recordInteraction("A", "B", "TALK_TO", "hello");
    h.store.recordInteraction("A", "B", "GIVE_GIFT", "I gave them 1 crop:parsnip");
    const evts = h.events.filter((e) => e.kind === "relationship_updated");
    expect(evts).toHaveLength(2);
    expect(evts[0].agentName).toBe("A");
    expect(evts[0].payload).toEqual({ otherName: "B", affinity: 2, delta: 2 });
    expect(evts[1].payload).toEqual({ otherName: "B", affinity: 12, delta: 10 });
    expect(h.changed).toEqual(["A", "A"]); // inspector feed notified
  });
});

describe("summary text", () => {
  it("mock template counts talks and gift directions", () => {
    const h = makeHarness();
    h.now.stamp = { day: 1, phase: "morning" };
    h.store.recordInteraction("A", "B", "TALK_TO", "hi");
    h.store.recordInteraction("A", "B", "TALK_TO", "hi again");
    h.store.recordInteraction("A", "B", "GIVE_GIFT", "they gave me 1 crop:parsnip");
    h.store.recordInteraction("A", "B", "GIVE_GIFT", "I gave them 1 seed:parsnip");
    // summary refreshed once this day — counts at refresh time (first
    // interaction), so force a new day to see the full template.
    h.now.stamp = { day: 2, phase: "morning" };
    h.store.recordInteraction("A", "B", "TALK_TO", "morning!");
    expect(h.store.get("A", "B")!.summary).toBe(
      "we talked 3 times; they gave me 1 gift; I gave them 1 gift",
    );
    expect(templateSummary({ talks: 1, giftsReceived: 0, giftsGiven: 0 })).toBe(
      "we talked 1 time",
    );
  });

  it("refreshes lazily at most once per day per pair (live call budget)", async () => {
    const h = makeHarness({
      live: true,
      router: async () => ({ raw: "She is my dearest friend.", model: "live", latencyMs: 1 }),
    });
    h.store.recordInteraction("A", "B", "TALK_TO", "hi");
    h.store.recordInteraction("A", "B", "TALK_TO", "hi again");
    h.store.recordInteraction("A", "C", "TALK_TO", "hello C");
    await flush();
    expect(h.calls).toHaveLength(2); // one per PAIR per day, not per interaction
    expect(h.store.get("A", "B")!.summary).toBe("She is my dearest friend.");

    h.now.stamp = { day: 2, phase: "morning" };
    h.store.recordInteraction("A", "B", "TALK_TO", "new day");
    await flush();
    expect(h.calls).toHaveLength(3); // re-armed by the new day
  });

  it("live one-liner failures leave the template in place", async () => {
    const h = makeHarness({
      live: true,
      router: async () => ({ raw: "", model: "unknown", latencyMs: 1, error: "boom" }),
    });
    h.store.recordInteraction("A", "B", "TALK_TO", "hi");
    await flush();
    expect(h.store.get("A", "B")!.summary).toBe("we talked 1 time");
  });

  it("sanitizeOneLiner strips fences/quotes and truncates", () => {
    expect(sanitizeOneLiner('```\n"Best friends forever."\n```')).toBe(
      "Best friends forever.",
    );
    expect(sanitizeOneLiner("\n\n  'A pal.'  \n")).toBe("A pal.");
    expect(sanitizeOneLiner("")).toBeNull();
    expect(sanitizeOneLiner("x".repeat(300))!.length).toBeLessThanOrEqual(140);
  });
});

describe("topFor (Observation/card feed)", () => {
  it("caps at 5, newest day first, then strongest affinity", () => {
    const h = makeHarness();
    h.now.stamp = { day: 1, phase: "morning" };
    for (const other of ["B", "C", "D", "E", "F", "G"]) {
      h.store.recordInteraction("A", other, "TALK_TO", "hi");
    }
    h.store.recordInteraction("A", "D", "GIVE_GIFT", "I gave them 1 crop:parsnip");
    h.now.stamp = { day: 2, phase: "morning" };
    h.store.recordInteraction("A", "G", "TALK_TO", "newest");

    const top = h.store.topFor("A", 5);
    expect(top).toHaveLength(5);
    expect(top[0].otherName).toBe("G"); // newest day wins
    expect(top[1].otherName).toBe("D"); // then |affinity| 12 beats the 2s
    expect(top.map((r) => r.otherName)).not.toContain("F"); // capped out (ties by name)
  });
});
