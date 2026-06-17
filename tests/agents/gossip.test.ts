/**
 * Gossip diffusion tests — Build (v3 Smallville).
 *
 * Verifies the single-hop, first-person gossip mechanism added to
 * CognitionSystem.onTalk():
 *   - Speaker with a high-importance (≥5) first-person observation passes
 *     a gist to the listener as `"${speaker} mentioned: ${gist}"`.
 *   - Dedup: the same gist is NOT written twice for the same pair.
 *   - Hearsay is NOT relayed: memories whose text starts with a pattern
 *     matching "X mentioned:" / "X told me" / "X said:" are excluded.
 *   - No qualifying memory (all importance < 5) → no gossip written.
 *   - Defensive: never throws.
 *   - Bus: a "gossip" WorldEvent is emitted when gossip fires.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
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

// ---------------------------------------------------------------------------
// Core gossip functionality
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
    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

    const danMems = cog.memory.all("Dan");
    const gossipMem = danMems.find((m) => m.text.startsWith("Carol mentioned:"));
    expect(gossipMem).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe("gossip — dedup: same gist is not written twice for the same pair", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("second onTalk with the same pair does NOT add a second copy of the same gist", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    await cog.write("Alice", "observation", "I harvested a golden parsnip today", 8);

    cog.onTalk(alice, bob, "First chat");
    cog.onTalk(alice, bob, "Second chat");

    await new Promise((r) => setTimeout(r, 20));

    const bobMems = cog.memory
      .all("Bob")
      .filter((m) => m.text.includes("Alice mentioned:") && m.text.includes("golden parsnip"));

    // Only one gossip memory — not duplicated.
    expect(bobMems).toHaveLength(1);
  });

  it("dedup is per-pair: same gist CAN be shared with a different listener", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    await cog.write("Alice", "observation", "I discovered a new well in the village", 6);

    cog.onTalk(alice, bob, "Hello!");
    cog.onTalk(alice, carol, "Hello!");

    await new Promise((r) => setTimeout(r, 20));

    const bobGossip = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    const carolGossip = cog.memory.all("Carol").filter((m) => m.text.includes("Alice mentioned:"));

    // Both listeners should have received the gossip independently.
    expect(bobGossip).toHaveLength(1);
    expect(carolGossip).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hearsay is NOT relayed
// ---------------------------------------------------------------------------

describe("gossip — hearsay is not relayed", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("'X mentioned: ...' pattern is excluded — hearsay is not forwarded", async () => {
    const { cog } = makeCognition();
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    // Bob's only high-importance memory is gossip he received (hearsay).
    // Directly inject via write so importance is set explicitly.
    await cog.write("Bob", "observation", "Alice mentioned: I harvested a golden parsnip", 8);

    cog.onTalk(bob, carol, "Hey!");

    await new Promise((r) => setTimeout(r, 20));

    const carolMems = cog.memory.all("Carol");
    // Carol must NOT receive Bob forwarding Alice's gossip.
    const forwarded = carolMems.filter(
      (m) => m.text.includes("Bob mentioned:") && m.text.includes("Alice mentioned:"),
    );
    expect(forwarded).toHaveLength(0);
  });

  it("'X told me ...' pattern is excluded — hearsay is not forwarded", async () => {
    const { cog } = makeCognition();
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    await cog.write("Bob", "observation", "Alice told me about the festival", 9);

    cog.onTalk(bob, carol, "Good day!");

    await new Promise((r) => setTimeout(r, 20));

    const carolMems = cog.memory.all("Carol");
    const forwarded = carolMems.filter(
      (m) => m.text.includes("Bob mentioned:") && m.text.includes("told me"),
    );
    expect(forwarded).toHaveLength(0);
  });

  it("'X said: ...' pattern is excluded — hearsay is not forwarded", async () => {
    const { cog } = makeCognition();
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    await cog.write("Bob", "observation", "Alice said: come to the tavern tonight", 7);

    cog.onTalk(bob, carol, "Howdy!");

    await new Promise((r) => setTimeout(r, 20));

    const carolMems = cog.memory.all("Carol");
    const forwarded = carolMems.filter(
      (m) => m.text.includes("Bob mentioned:") && m.text.includes("said:"),
    );
    expect(forwarded).toHaveLength(0);
  });

  it("hearsay exclusion fires even when hearsay has highest importance", async () => {
    const { cog } = makeCognition();
    const bob = makeAgent("Bob");
    const carol = makeAgent("Carol");
    cog.registerAgent(bob);
    cog.registerAgent(carol);

    // Only memory is hearsay with importance 10 — must not be relayed.
    await cog.write("Bob", "observation", "Alice mentioned: the world is ending", 10);

    cog.onTalk(bob, carol, "...");

    await new Promise((r) => setTimeout(r, 20));

    const carolMems = cog.memory.all("Carol");
    // No gossip memory at all for Carol since Bob's only high-imp mem is hearsay.
    const gossipMems = carolMems.filter((m) => m.text.includes("Bob mentioned:"));
    expect(gossipMems).toHaveLength(0);
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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

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

    await new Promise((r) => setTimeout(r, 20));

    const bobMems = cog.memory.all("Bob").filter((m) => m.text.includes("Alice mentioned:"));
    // Only one gossip memory (dedup).
    expect(bobMems).toHaveLength(1);
    // Should contain the most important memory (treasure chest, imp 9).
    expect(bobMems[0].text).toContain("treasure chest");
  });
});
