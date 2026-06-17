/**
 * Conversation system tests — v3 Smallville back-and-forth.
 *
 * Coverage:
 *  - mockReply: deterministic + persona-flavored (social vs grumbling vs default
 *    give different, non-empty, in-character replies; A's name appears where natural).
 *  - Exchange via onTalk: B gains a memory of having replied, A gains a memory
 *    of hearing the reply, and a "conversation" bus event is emitted.
 *  - Defensive: blank say, null say, or unknown listener must not throw.
 *  - Existing onTalk behavior (diffusion/gossip side-effects) still runs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { mockReply } from "../../src/agents/Conversation";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Helpers (mirrors gossip.test.ts harness)
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

function makeAgentWithPersona(name: string, persona: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  const a = new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: persona,
    color: 0xffffff,
    start: pos,
  });
  return a;
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
// mockReply — unit tests
// ---------------------------------------------------------------------------

describe("mockReply — deterministic persona-flavored template", () => {
  it("social persona returns a warm non-empty reply", () => {
    const reply = mockReply("social chatty farmer", "Alice", "How are you?");
    expect(reply).toBeTruthy();
    expect(reply.length).toBeGreaterThan(0);
  });

  it("social persona reply contains A's name", () => {
    const reply = mockReply("social wanderer who values bonds", "Bob", "Hi there!");
    expect(reply).toContain("Bob");
  });

  it("grumbling persona returns a curt/terse reply", () => {
    const grumpy = mockReply("grumbling gruff perfectionist", "Alice", "Hey!");
    const social = mockReply("social chatty farmer", "Alice", "Hey!");
    // Different outputs for different personas
    expect(grumpy).not.toBe(social);
    expect(grumpy.length).toBeGreaterThan(0);
  });

  it("grumbling persona reply is curt (does not need A's name)", () => {
    const reply = mockReply("grumbling gruff old farmer", "Carol", "Want to chat?");
    // Curt reply — shorter / character-flavor word
    expect(reply).toBeTruthy();
    // should include "Hmph" for gruff persona
    expect(reply.toLowerCase()).toMatch(/hmph|if you say|curt/);
  });

  it("frugal persona reply mentions costs/copper", () => {
    const reply = mockReply("frugal bargain hunter who counts every copper", "Dave", "Let's trade!");
    expect(reply).toBeTruthy();
    expect(reply.toLowerCase()).toMatch(/copper|cost|count/);
  });

  it("reckless persona returns a breezy reply", () => {
    const reply = mockReply("reckless impulsive farmer", "Eve", "Come with me!");
    expect(reply).toBeTruthy();
    expect(reply.toLowerCase()).toMatch(/ha|sure|let/);
  });

  it("dreamy persona returns a whimsical reply containing A's name", () => {
    const reply = mockReply("moonstruck dreamy stargazer", "Frank", "The sky is nice today.");
    expect(reply).toBeTruthy();
    expect(reply).toContain("Frank");
  });

  it("default persona returns neutral reply containing A's name", () => {
    const reply = mockReply("plain farmer with no special traits", "Grace", "Hello.");
    expect(reply).toBeTruthy();
    expect(reply).toContain("Grace");
  });

  it("social vs grumbling produce different replies", () => {
    const social = mockReply("social chatty villager", "Harry", "Good morning!");
    const grumpy = mockReply("grumbling gruff elder", "Harry", "Good morning!");
    expect(social).not.toBe(grumpy);
  });

  it("grumbling vs default produce different replies", () => {
    const grumpy = mockReply("grumbling gruff elder", "Iris", "Nice day!");
    const neutral = mockReply("a quiet unassuming farmer", "Iris", "Nice day!");
    expect(grumpy).not.toBe(neutral);
  });

  it("social vs default produce different replies", () => {
    const social = mockReply("social chatty person", "Jake", "Hey!");
    const neutral = mockReply("a quiet farmer", "Jake", "Hey!");
    expect(social).not.toBe(neutral);
  });
});

// ---------------------------------------------------------------------------
// Exchange via onTalk — memory + bus event
// ---------------------------------------------------------------------------

describe("conversation exchange — memory and bus event via onTalk", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("B gains a memory of having replied after onTalk", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Hey Bob, how's the farm?");

    // Allow fire-and-forget async work to settle.
    await new Promise((r) => setTimeout(r, 30));

    const bobMems = cog.memory.all("Bob");
    const replyMem = bobMems.find((m) => m.text.startsWith("I told Alice:"));
    expect(replyMem).toBeDefined();
    expect(replyMem!.type).toBe("observation");
    expect(replyMem!.importance).toBe(5);
  });

  it("A gains a memory of hearing B's reply after onTalk", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "How are you, Bob?");

    await new Promise((r) => setTimeout(r, 30));

    const aliceMems = cog.memory.all("Alice");
    const heardMem = aliceMems.find((m) => m.text.startsWith("Bob replied:"));
    expect(heardMem).toBeDefined();
    expect(heardMem!.type).toBe("observation");
    expect(heardMem!.importance).toBe(5);
  });

  it("a 'conversation' bus event is emitted with both lines", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    const say = "Good morning, Bob!";
    cog.onTalk(alice, bob, say);

    await new Promise((r) => setTimeout(r, 30));

    const convEvent = events.find((e) => e.kind === "conversation");
    expect(convEvent).toBeDefined();
    expect(convEvent!.agentName).toBe("Alice");
    expect(convEvent!.text).toContain("Alice");
    expect(convEvent!.text).toContain("Bob");
    expect(convEvent!.text).toContain(say);
    // The payload should have both sides
    expect(convEvent!.payload?.speaker).toBe("Alice");
    expect(convEvent!.payload?.listener).toBe("Bob");
    expect(convEvent!.payload?.say).toBe(say);
    expect(typeof convEvent!.payload?.reply).toBe("string");
    expect((convEvent!.payload?.reply as string).length).toBeGreaterThan(0);
  });

  it("'conversation' event text contains both A's say and B's reply inline", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "See you at the shop!");

    await new Promise((r) => setTimeout(r, 30));

    const convEvent = events.find((e) => e.kind === "conversation");
    expect(convEvent).toBeDefined();
    // Both sides appear: A's opener and B's reply, separated by em dash.
    expect(convEvent!.text).toContain("See you at the shop!");
    expect(convEvent!.text).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// Defensive — blank/null say must not throw
// ---------------------------------------------------------------------------

describe("conversation — defensive: blank or null say does not throw", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("onTalk with null say does not throw (no reply generated)", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    expect(() => cog.onTalk(alice, bob, null)).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    // No conversation event for a null say
    // (we can't easily check this without capturing events, but no throw is the key assertion)
  });

  it("onTalk with blank say (whitespace) does not throw", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    expect(() => cog.onTalk(alice, bob, "   ")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("no 'conversation' bus event for a null say", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, null);
    await new Promise((r) => setTimeout(r, 20));

    const convEvents = events.filter((e) => e.kind === "conversation");
    expect(convEvents).toHaveLength(0);
  });

  it("no 'conversation' bus event for a blank say", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "   ");
    await new Promise((r) => setTimeout(r, 20));

    const convEvents = events.filter((e) => e.kind === "conversation");
    expect(convEvents).toHaveLength(0);
  });

  it("onTalk with unregistered agents (no-op) does not throw", () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    // NOT registered
    expect(() => cog.onTalk(alice, bob, "Hello!")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persona-flavored replies through onTalk
// ---------------------------------------------------------------------------

describe("conversation — persona flavor flows through to the reply memory", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("social listener produces warm reply in memory", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const sage = makeAgentWithPersona(
      "Social Sage",
      "Social Sage — a chatty wanderer who values social bonds over gold.",
      { x: 5, y: 6 },
    );
    cog.registerAgent(alice);
    cog.registerAgent(sage);

    cog.onTalk(alice, sage, "Hi there!");

    await new Promise((r) => setTimeout(r, 30));

    const sageMems = cog.memory.all("Social Sage");
    const replyMem = sageMems.find((m) => m.text.startsWith("I told Alice:"));
    expect(replyMem).toBeDefined();
    // Social persona should mention Alice warmly
    expect(replyMem!.text.toLowerCase()).toContain("alice");
  });

  it("grumbling listener produces curt reply in memory", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const gus = makeAgentWithPersona(
      "Grumbling Gus",
      "Grumbling Gus — a gruff perfectionist with a soft center.",
      { x: 5, y: 6 },
    );
    cog.registerAgent(alice);
    cog.registerAgent(gus);

    cog.onTalk(alice, gus, "Good morning!");

    await new Promise((r) => setTimeout(r, 30));

    const gusMems = cog.memory.all("Grumbling Gus");
    const replyMem = gusMems.find((m) => m.text.startsWith("I told Alice:"));
    expect(replyMem).toBeDefined();
    // Grumpy reply should contain "Hmph" or "say so"
    expect(replyMem!.text.toLowerCase()).toMatch(/hmph|say so/);
  });
});

// ---------------------------------------------------------------------------
// Existing onTalk behavior still works (diffusion/gossip/relationships)
// ---------------------------------------------------------------------------

describe("conversation — existing onTalk side-effects still fire", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("relationship recordInteraction still fires for both agents after onTalk", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Hey Bob!");

    // Affinity should have been bumped for both sides
    const aliceRel = cog.relationships.get("Alice", "Bob");
    const bobRel = cog.relationships.get("Bob", "Alice");
    expect(aliceRel?.affinity).toBeGreaterThan(0);
    expect(bobRel?.affinity).toBeGreaterThan(0);
  });

  it("event diffusion still works alongside conversation reply", async () => {
    const { cog } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    const evt = {
      id: "conv-evt-test",
      host: "Alice",
      location: { x: 10, y: 5 },
      day: 1,
      phase: "evening" as const,
      description: "a gathering at the tavern",
    };
    cog.seedEvent(evt);

    expect(cog.events.knows(evt.id, "Bob")).toBe(false);
    cog.onTalk(alice, bob, "Come to the gathering tonight!");
    expect(cog.events.knows(evt.id, "Bob")).toBe(true);

    // Conversation event also fires
    await new Promise((r) => setTimeout(r, 30));
    // Bob has both an event-diffusion memory and a reply memory
    const bobMems = cog.memory.all("Bob");
    const inviteMem = bobMems.find((m) => m.text.includes("Alice told me about"));
    expect(inviteMem).toBeDefined();
    const replyMem = bobMems.find((m) => m.text.startsWith("I told Alice:"));
    expect(replyMem).toBeDefined();
  });

  it("gossip still fires alongside conversation reply", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", { x: 5, y: 5 });
    const bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    // Give Alice a high-importance memory to gossip
    await cog.write("Alice", "observation", "I found a legendary treasure in the field", 9);

    cog.onTalk(alice, bob, "Did you hear the news?");

    await new Promise((r) => setTimeout(r, 30));

    // Gossip event still fires
    const gossipEvent = events.find((e) => e.kind === "gossip");
    expect(gossipEvent).toBeDefined();

    // AND conversation event also fires
    const convEvent = events.find((e) => e.kind === "conversation");
    expect(convEvent).toBeDefined();
  });
});
