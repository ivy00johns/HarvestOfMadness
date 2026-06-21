/**
 * Phase C · Slice C1 — warmth-only sentiment → affinity (the payoff).
 *
 * Through the REAL Cognition.onTalk + await SETTLE() (same harness as
 * conversation-multiturn.test.ts), proves the strictly-additive warmth bonus:
 *  - WARM conversation → > +2 both sides, EQUAL (symmetric), pinned to the EXACT
 *    computed value (+2 floor + warmthBonus(transcript));
 *  - NEUTRAL conversation → exactly +2 both sides (byte-identical to today);
 *  - a SECOND "relationship_updated" event fires with delta === bonus for the
 *    warm case, its affinity in [-100, 100] (keeps the v2-full-loop invariant);
 *    NO warmth event fires for the neutral case;
 *  - determinism: two identical warm runs → identical affinity + event sequence.
 *
 * Warm transcript (dreamy A + dreamy B, warm opener "Hello dear friend!"):
 *   ["Hello dear friend!",                              // dear, friend  → 2
 *    "The fields hold many stories… I hear you, Alice.", // 0
 *    "The fields hold many stories… I hear you, Bob.",   // 0
 *    "Such wondrous thoughts, Alice — go on."]           // wondrous      → 1
 *   ⇒ warmthBonus = 3 ⇒ affinity 2 + 3 = 5 / side.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, Router, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { resetWorldForTests } from "../../src/world/instance";

function makeStampBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => { events.push({ ...e, seq: ++seq, ts: Date.now() }); },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

function makeAgent(name: string, persona: string, pos: Vec2): Agent {
  return new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: persona,
    color: 0xffffff,
    start: pos,
  });
}

interface Harness {
  cog: CognitionSystem;
  events: WorldEvent[];
}

function makeCognition(opts?: { live?: boolean; router?: Router }): Harness {
  const { bus, events } = makeStampBus();
  const now: () => GameStamp = () => ({ day: 1, phase: "morning" });
  const cog = new CognitionSystem({
    bus,
    live: () => opts?.live ?? false,
    now,
    ...(opts?.router ? { router: opts.router } : {}),
  });
  return { cog, events };
}

function relUpdates(events: WorldEvent[], agentName: string, otherName: string): WorldEvent[] {
  return events.filter(
    (e) =>
      e.kind === "relationship_updated" &&
      e.agentName === agentName &&
      (e.payload?.otherName as string) === otherName,
  );
}

const SETTLE = () => new Promise((r) => setTimeout(r, 50));

// Warm: both dreamy so neither closes early; warm opener carries dear+friend.
const WARM_OPENER = "Hello dear friend!";
const EXPECTED_WARM_BONUS = 3; // dear + friend (opener) + wondrous (B turn 3)
const EXPECTED_WARM_AFFINITY = 2 + EXPECTED_WARM_BONUS; // +2 floor + warmth bonus

beforeEach(() => { resetWorldForTests(); });

describe("sentiment → affinity — warm conversation earns a bonus on top of +2", () => {
  it("a warm conversation yields > +2, equal on both sides, at the EXACT computed value", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", "a dreamy moonstruck wanderer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "a dreamy moonstruck wanderer", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, WARM_OPENER);
    await SETTLE();

    const ab = cog.relationships.get("Alice", "Bob")?.affinity;
    const ba = cog.relationships.get("Bob", "Alice")?.affinity;
    expect(ab).toBeGreaterThan(2); // strictly above the neutral floor
    expect(ab).toBe(EXPECTED_WARM_AFFINITY); // exact: +2 + 3
    expect(ba).toBe(EXPECTED_WARM_AFFINITY); // symmetric — both directions equal
  });

  it("a SECOND relationship_updated event fires with delta === bonus, affinity in [-100,100]", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a dreamy moonstruck wanderer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "a dreamy moonstruck wanderer", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, WARM_OPENER);
    await SETTLE();

    // Per side: the synchronous +2 event (delta 2) PLUS the warmth event (delta=bonus).
    const aToB = relUpdates(events, "Alice", "Bob");
    expect(aToB.length).toBe(2);
    const sync = aToB[0];
    const warmth = aToB[1];
    expect(sync.payload?.delta).toBe(2);
    expect(warmth.payload?.delta).toBe(EXPECTED_WARM_BONUS);
    expect(warmth.payload?.affinity).toBe(EXPECTED_WARM_AFFINITY);
    // v2-full-loop invariant: every relationship_updated affinity is in range.
    for (const e of events.filter((x) => x.kind === "relationship_updated")) {
      const aff = e.payload?.affinity as number;
      expect(typeof aff).toBe("number");
      expect(aff).toBeGreaterThanOrEqual(-100);
      expect(aff).toBeLessThanOrEqual(100);
    }
  });
});

describe("sentiment → affinity — neutral conversation is still exactly +2 (additive guarantee)", () => {
  it("a grumbling neutral conversation yields exactly +2 both sides", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Tell me everything!");
    await SETTLE();

    expect(cog.relationships.get("Alice", "Bob")?.affinity).toBe(2);
    expect(cog.relationships.get("Bob", "Alice")?.affinity).toBe(2);
  });

  it("NO warmth event fires for a neutral conversation — exactly ONE relationship_updated per side", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Tell me everything!");
    await SETTLE();

    // Only the synchronous +2 event per direction — no second (warmth) mutation.
    expect(relUpdates(events, "Alice", "Bob").length).toBe(1);
    expect(relUpdates(events, "Bob", "Alice").length).toBe(1);
    expect(relUpdates(events, "Alice", "Bob")[0].payload?.delta).toBe(2);
  });
});

describe("sentiment → affinity — determinism", () => {
  it("two identical warm runs produce identical affinity and event sequence", async () => {
    const run = async () => {
      resetWorldForTests();
      const { cog, events } = makeCognition();
      const alice = makeAgent("Alice", "a dreamy moonstruck wanderer", { x: 5, y: 5 });
      const bob = makeAgent("Bob", "a dreamy moonstruck wanderer", { x: 5, y: 6 });
      cog.registerAgent(alice);
      cog.registerAgent(bob);
      cog.onTalk(alice, bob, WARM_OPENER);
      await SETTLE();
      const rel = [
        cog.relationships.get("Alice", "Bob")?.affinity,
        cog.relationships.get("Bob", "Alice")?.affinity,
      ];
      const relSeq = events
        .filter((e) => e.kind === "relationship_updated")
        .map((e) => `${e.agentName}->${e.payload?.otherName}:${e.payload?.delta}:${e.payload?.affinity}`);
      return { rel, relSeq };
    };

    const first = await run();
    const second = await run();
    expect(second.rel).toEqual(first.rel);
    expect(second.relSeq).toEqual(first.relSeq);
    expect(first.rel).toEqual([EXPECTED_WARM_AFFINITY, EXPECTED_WARM_AFFINITY]);
  });
});
