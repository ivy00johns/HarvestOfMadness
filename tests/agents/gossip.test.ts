/**
 * Gossip diffusion tests — Wave 4b (bounded multi-hop relay).
 *
 * Verifies the multi-hop, origin-tracked, belief-decaying gossip mechanism in
 * CognitionSystem.onTalk():
 *   - First-hand share: a speaker with a high-importance (≥5) first-person
 *     observation (origin===undefined) passes a gist to the listener as
 *     `"${speaker} mentioned: ${gist}"` at importance 4, hop 1, with the
 *     SOURCE memory id as the stable story-origin.
 *   - Bounded relay: a held gossip memory is re-shared one hop further
 *     (`"${relayer} mentioned (heard from ${origin teller}): ${gist}"`) with
 *     the origin propagated UNCHANGED, the hop incremented, and the importance
 *     decayed 0.6/hop with a relay floor.
 *   - Origin-dedup (absorbing): a listener already holding a story's origin is
 *     never re-told it → ≤ N−1 writes per origin, no loop-back.
 *   - Hard hop cap GOSSIP_MAX_HOPS=3: a memory at hop≥3 is never re-relayed.
 *   - TERMINATION/anti-storm: an all-pairs flood provably stabilizes.
 *   - Determinism: same schedule twice → byte-identical gossip memories.
 *   - Defensive: never throws.
 *   - Bus: a "gossip" WorldEvent is emitted when gossip fires.
 *
 * The single-hop hearsay-exclusion guarantee was the intended Wave 4b
 * relaxation and is REPLACED by the bounded-multi-hop guarantees below.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, MemoryEntry, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import {
  CognitionSystem,
  GOSSIP_MAX_HOPS,
  gossipCore,
  gossipTeller,
} from "../../src/agents/Cognition";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeAgent(name: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  return new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: `${name} — test agent`,
    color: 0xffffff,
    start: pos,
  });
}

function makeCognition(opts?: { now?: () => GameStamp }): {
  cog: CognitionSystem;
  bus: EventBus;
  events: WorldEvent[];
} {
  const { bus, events } = makeStampBus();
  const now: () => GameStamp = opts?.now ?? (() => ({ day: 1, phase: "morning" }));
  const cog = new CognitionSystem({ bus, live: () => false, now });
  return { cog, bus, events };
}

/** Let fire-and-forget memory writes settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** All gossip (relayed) memories an agent holds — those with an origin set. */
function gossipMemsOf(cog: CognitionSystem, name: string): MemoryEntry[] {
  return cog.memory.all(name).filter((m) => m.origin !== undefined);
}

// ---------------------------------------------------------------------------
// Core gossip functionality (first-hand share — green by construction)
// ---------------------------------------------------------------------------

describe("gossip — speaker shares first-person observation with listener", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("listener receives a 'mentioned:' memory after onTalk when speaker has a high-importance obs", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // Seed a first-person high-importance memory for Alice.
    await cog.write("Alice", "observation", "I harvested a golden parsnip today", 8);

    cog.onTalk(alice, bob, "Hey there!");

    // Allow async memory writes to settle.
    await settle();

    const bobMems = cog.memory.all("Bob");
    const gossipMem = bobMems.find(
      (m) => m.text.includes("Alice mentioned:") && m.text.includes("golden parsnip"),
    );
    expect(gossipMem).toBeDefined();
    expect(gossipMem!.type).toBe("observation");
    expect(gossipMem!.importance).toBe(4);
  });

  it("gossip memory text starts with '<SpeakerName> mentioned:'", async () => {
    const { cog } = makeCognition();
    const carol = makeAgent("Carol");
    const dan = makeAgent("Dan");
    cog.registerAgent(carol);
    cog.registerAgent(dan);

    await cog.write("Carol", "observation", "I found a rare mushroom in the forest", 7);

    cog.onTalk(carol, dan, null);

    await settle();

    const danMems = cog.memory.all("Dan");
    const gossipMem = danMems.find((m) => m.text.startsWith("Carol mentioned:"));
    expect(gossipMem).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Origin-dedup: the same story is not re-told (replaces the old pair+memId dedup)
// ---------------------------------------------------------------------------

describe("gossip — origin-dedup: a held story is not re-told to the same pair", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("second onTalk with the same pair does NOT add a second copy of the same gist", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    await cog.write("Alice", "observation", "I harvested a golden parsnip today", 8);

    cog.onTalk(alice, bob, "First chat");
    await settle();
    cog.onTalk(alice, bob, "Second chat");
    await settle();

    const bobMems = cog.memory
      .all("Bob")
      .filter((m) => m.text.includes("Alice mentioned:") && m.text.includes("golden parsnip"));

    // Only one gossip memory — the listener already holds that origin.
    expect(bobMems).toHaveLength(1);
  });

  it("dedup is per-origin per-listener: same story CAN be shared with a different listener", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    await cog.write("Alice", "observation", "I discovered a new well in the village", 6);

    cog.onTalk(alice, bob, "Hello!");
    await settle();
    cog.onTalk(alice, carol, "Hello!");
    await settle();

    const bobGossip = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    const carolGossip = cog.memory.all("Carol").filter((m) => m.text.includes("Alice mentioned:"));

    // Each listener learns the origin exactly once.
    expect(bobGossip).toHaveLength(1);
    expect(carolGossip).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// No qualifying memory
// ---------------------------------------------------------------------------

describe("gossip — no qualifying memory means no gossip written", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("all memories below importance 5 → no gossip written for listener", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // Write low-importance memories.
    await cog.write("Alice", "observation", "I watered the crops", 2);
    await cog.write("Alice", "observation", "I tilled the soil", 3);
    await cog.write("Alice", "observation", "I walked to the shop", 4);

    cog.onTalk(alice, bob, "Hi!");

    await settle();

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    expect(bobMems).toHaveLength(0);
  });

  it("no memories at all for speaker → no gossip written", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // Alice has no memories.
    cog.onTalk(alice, bob, "Hello!");

    await settle();

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    expect(bobMems).toHaveLength(0);
  });

  it("importance exactly 5 IS included (boundary)", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    await cog.write("Alice", "observation", "I found a five-gold coin", 5);

    cog.onTalk(alice, bob, "Hi!");

    await settle();

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    expect(bobMems).toHaveLength(1);
  });

  it("importance exactly 4 is NOT included (below boundary)", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    await cog.write("Alice", "observation", "I found a four-gold coin", 4);

    cog.onTalk(alice, bob, "Hi!");

    await settle();

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    expect(bobMems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Defensive: never throws
// ---------------------------------------------------------------------------

describe("gossip — defensive: never throws", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("onTalk never throws even with no registered agents or bizarre memory state", () => {
    const { cog } = makeCognition();
    // Agents NOT registered — should still not throw.
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    expect(() => cog.onTalk(alice, bob, "test")).not.toThrow();
  });

  it("onTalk never throws when speaker has many high-importance memories", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    for (let i = 0; i < 20; i++) {
      await cog.write("Alice", "observation", `I did thing number ${i}`, 7);
    }

    expect(() => cog.onTalk(alice, bob, "chat")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bus event
// ---------------------------------------------------------------------------

describe("gossip — bus event 'gossip' is emitted when gossip fires", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("emits a 'gossip' WorldEvent on the bus when gossip is shared", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    await cog.write("Alice", "observation", "I discovered a new spring", 8);

    cog.onTalk(alice, bob, "Hey!");

    await settle();

    const gossipEvent = events.find((e) => e.kind === "gossip");
    expect(gossipEvent).toBeDefined();
    expect(gossipEvent!.agentName).toBe("Alice");
    expect(gossipEvent!.text).toContain("Alice");
    expect(gossipEvent!.text).toContain("Bob");
  });

  it("no 'gossip' bus event is emitted when no qualifying memory exists", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // No memories for Alice.
    cog.onTalk(alice, bob, "Hi!");

    await settle();

    const gossipEvents = events.filter((e) => e.kind === "gossip");
    expect(gossipEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Salience: highest-importance memory is chosen
// ---------------------------------------------------------------------------

describe("gossip — salience: speaker shares their most important memory", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("picks the highest-importance qualifying memory to share", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // Write multiple qualifying memories at different importance levels.
    await cog.write("Alice", "observation", "I watered the south plot today", 5);
    await cog.write("Alice", "observation", "I found a treasure chest buried near the well", 9);
    await cog.write("Alice", "observation", "I talked to the merchant briefly", 6);

    cog.onTalk(alice, bob, "Hello!");

    await settle();

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    // Only one gossip memory (one origin per onTalk).
    expect(bobMems).toHaveLength(1);
    // Should contain the most important memory (treasure chest, imp 9).
    expect(bobMems[0].text).toContain("treasure chest");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("gossip — pure helpers (gossipCore / gossipTeller)", () => {
  it("gossipCore strips the hop-1 wrapper and the hop>=2 provenance wrapper", () => {
    expect(gossipCore("Alice mentioned: I found a chest")).toBe("I found a chest");
    expect(gossipCore("Bob mentioned (heard from Alice): I found a chest")).toBe(
      "I found a chest",
    );
    // Non-gossip text is returned unchanged (no growth, idempotent core).
    expect(gossipCore("I found a chest")).toBe("I found a chest");
  });

  it("gossipTeller extracts the immediate prior teller, null on non-gossip text", () => {
    expect(gossipTeller("Alice mentioned: I found a chest")).toBe("Alice");
    expect(gossipTeller("Bob mentioned (heard from Alice): I found a chest")).toBe("Bob");
    expect(gossipTeller("I found a chest")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave 4b — bounded multi-hop relay
// ---------------------------------------------------------------------------

describe("multi-hop relay (bounded)", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("(1) A→B→C relay: C gets a 'heard from Alice' memory, origin === Alice's obs id, hop === 2", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    const src = await cog.write(
      "Alice",
      "observation",
      "I found a treasure chest buried near the well",
      9,
    );
    expect(src).not.toBeNull();
    const originId = src!.id;

    // Empty say isolates the gossip path from conversation-reply noise.
    cog.onTalk(alice, bob, "");
    await settle();
    cog.onTalk(bob, carol, "");
    await settle();

    const bobMem = gossipMemsOf(cog, "Bob")[0];
    expect(bobMem.text).toBe("Alice mentioned: I found a treasure chest buried near the well");
    expect(bobMem.origin).toBe(originId);
    expect(bobMem.hop).toBe(1);

    const carolMems = gossipMemsOf(cog, "Carol");
    expect(carolMems).toHaveLength(1);
    const carolMem = carolMems[0];
    expect(carolMem.text).toContain("Bob mentioned (heard from Alice):");
    expect(carolMem.text).toContain("treasure chest");
    // Wrapper does NOT grow hop-over-hop — only the immediate prior teller +
    // the origin teller are surfaced.
    expect(carolMem.text).not.toContain("heard from Bob");
    expect(carolMem.origin).toBe(originId);
    expect(carolMem.hop).toBe(2);
  });

  it("(2) origin-dedup: B→A yields nothing (loop-back), A→B→C→A yields nothing, ≤ N−1 writes/origin", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    const src = await cog.write("Alice", "observation", "I saw a comet over the hills", 8);
    const originId = src!.id;

    // A→B
    cog.onTalk(alice, bob, "");
    await settle();
    // B→A: Alice originated the story (marked at first share) → no loop-back.
    cog.onTalk(bob, alice, "");
    await settle();
    expect(gossipMemsOf(cog, "Alice").filter((m) => m.origin === originId)).toHaveLength(0);

    // B→C
    cog.onTalk(bob, carol, "");
    await settle();
    // C→A: Alice already holds the origin → nothing.
    cog.onTalk(carol, alice, "");
    await settle();
    expect(gossipMemsOf(cog, "Alice").filter((m) => m.origin === originId)).toHaveLength(0);

    // Total memories carrying this origin across all 3 agents ≤ N−1 = 2.
    const total =
      gossipMemsOf(cog, "Alice").filter((m) => m.origin === originId).length +
      gossipMemsOf(cog, "Bob").filter((m) => m.origin === originId).length +
      gossipMemsOf(cog, "Carol").filter((m) => m.origin === originId).length;
    expect(total).toBe(2);
    expect(total).toBeLessThanOrEqual(2); // N−1 with N=3
  });

  it("(3) hop cap: A→B→C→D→E gives D a hop-3 memory and E NOTHING; no memory hop>3", async () => {
    const { cog } = makeCognition();
    const chain = ["A", "B", "C", "D", "E"].map((n) => makeAgent(n));
    chain.forEach((a) => cog.registerAgent(a));
    const [a, b, c, d, e] = chain;

    await cog.write("A", "observation", "I unearthed an ancient coin", 9);

    cog.onTalk(a, b, "");
    await settle();
    cog.onTalk(b, c, "");
    await settle();
    cog.onTalk(c, d, "");
    await settle();
    cog.onTalk(d, e, "");
    await settle();

    expect(gossipMemsOf(cog, "B")[0].hop).toBe(1);
    expect(gossipMemsOf(cog, "C")[0].hop).toBe(2);
    const dMems = gossipMemsOf(cog, "D");
    expect(dMems).toHaveLength(1);
    expect(dMems[0].hop).toBe(3);

    // E gets nothing — the hop-3 memory at D is at the cap and never re-relayed.
    expect(gossipMemsOf(cog, "E")).toHaveLength(0);

    // No memory anywhere exceeds the hop cap.
    for (const ag of chain) {
      for (const m of gossipMemsOf(cog, ag.name)) {
        expect(m.hop!).toBeLessThanOrEqual(GOSSIP_MAX_HOPS);
      }
    }
    void [a, b, c, d, e]; // referenced for clarity
  });

  it("(4) decay: hop1 imp 4, hop2 imp 2, hop3 imp 1, non-increasing", async () => {
    const { cog } = makeCognition();
    const chain = ["A", "B", "C", "D"].map((n) => makeAgent(n));
    chain.forEach((ag) => cog.registerAgent(ag));

    await cog.write("A", "observation", "I witnessed a great fire", 9);

    cog.onTalk(chain[0], chain[1], "");
    await settle();
    cog.onTalk(chain[1], chain[2], "");
    await settle();
    cog.onTalk(chain[2], chain[3], "");
    await settle();

    const hop1 = gossipMemsOf(cog, "B")[0];
    const hop2 = gossipMemsOf(cog, "C")[0];
    const hop3 = gossipMemsOf(cog, "D")[0];

    expect(hop1.importance).toBe(4);
    expect(hop2.importance).toBe(2);
    expect(hop3.importance).toBe(1);

    // Strictly non-increasing along the chain.
    expect(hop2.importance).toBeLessThanOrEqual(hop1.importance);
    expect(hop3.importance).toBeLessThanOrEqual(hop2.importance);
  });

  it("(5) TERMINATION/anti-storm: 6 agents, 50 all-pairs rounds, write-count stabilizes AND ≤ N−1 AND no hop>3", async () => {
    const { cog } = makeCognition();
    const names = ["A0", "A1", "A2", "A3", "A4", "A5"];
    const agents = names.map((n) => makeAgent(n));
    agents.forEach((a) => cog.registerAgent(a));
    const N = agents.length;

    // Seed exactly one rumor in A0.
    const src = await cog.write("A0", "observation", "I heard the river will flood", 9);
    const originId = src!.id;

    const countWrites = (): number =>
      names.reduce(
        (sum, n) => sum + gossipMemsOf(cog, n).filter((m) => m.origin === originId).length,
        0,
      );

    let countAt25 = -1;
    for (let round = 0; round < 50; round++) {
      // One full all-pairs sweep (both directions) per round.
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          // Empty say isolates the gossip path from conversation-reply noise.
          cog.onTalk(agents[i], agents[j], "");
        }
      }
      await settle();
      if (round === 24) countAt25 = countWrites();
    }
    const countAt50 = countWrites();

    // Stabilizes: the flood has reached its fixed point well before round 25.
    expect(countAt25).toBe(countAt50);
    // Absorbing bound: at most N−1 agents ever learn the origin.
    expect(countAt50).toBeLessThanOrEqual(N - 1);
    expect(countAt50).toBe(N - 1); // every other agent learned it
    // Hop cap holds across the entire flood.
    for (const n of names) {
      for (const m of gossipMemsOf(cog, n)) {
        expect(m.hop!).toBeLessThanOrEqual(GOSSIP_MAX_HOPS);
      }
    }
  });

  it("(6) determinism: same schedule twice → identical gossip memory texts/origins/hops/importances", async () => {
    const runOnce = async (): Promise<
      { name: string; text: string; origin?: string; hop?: number; importance: number }[]
    > => {
      resetWorldForTests();
      const { cog } = makeCognition();
      const names = ["A", "B", "C", "D"];
      const agents = names.map((n) => makeAgent(n));
      agents.forEach((a) => cog.registerAgent(a));

      await cog.write("A", "observation", "I spotted a stranger at dawn", 8);

      // Fixed schedule.
      const schedule: [number, number][] = [
        [0, 1],
        [1, 2],
        [0, 2],
        [2, 3],
        [1, 3],
      ];
      for (const [s, l] of schedule) {
        // Empty say isolates the deterministic relay path.
        cog.onTalk(agents[s], agents[l], "");
        await settle();
      }

      const out: {
        name: string;
        text: string;
        origin?: string;
        hop?: number;
        importance: number;
      }[] = [];
      for (const n of names) {
        for (const m of gossipMemsOf(cog, n)) {
          out.push({
            name: n,
            text: m.text,
            origin: m.origin,
            hop: m.hop,
            importance: m.importance,
          });
        }
      }
      return out;
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
    // Sanity: the schedule actually produced relay memories.
    expect(first.length).toBeGreaterThan(0);
  });

  it("(7) first-hand preference: a fresh first-hand imp-9 beats a held hop-1 rumor", async () => {
    const { cog } = makeCognition();
    const zoe = makeAgent("Zoe");
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(zoe);
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    // Zoe relays a rumor to Bob (Bob now holds a hop-1, imp-4 gossip memory).
    await cog.write("Zoe", "observation", "I overheard a secret deal", 7);
    cog.onTalk(zoe, bob, "");
    await settle();

    // Bob also makes a fresh, high-importance first-hand observation.
    await cog.write("Bob", "observation", "I struck gold in the north field", 9);

    // Bob talks to Carol: he should share the FIRST-HAND gold story (hop 1, no
    // "heard from"), not the held rumor — salience is by source importance.
    cog.onTalk(bob, carol, "");
    await settle();

    const carolMems = gossipMemsOf(cog, "Carol");
    expect(carolMems).toHaveLength(1);
    const m = carolMems[0];
    expect(m.text).toBe("Bob mentioned: I struck gold in the north field");
    expect(m.hop).toBe(1);
    expect(m.text).not.toContain("heard from");
  });
});
