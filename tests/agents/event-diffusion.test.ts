/**
 * v3 — Event model + diffusion plumbing (Build 1).
 *
 * Tests the EventBoard data model and the CognitionSystem.seedEvent /
 * onTalk diffusion mechanism. No LLM calls, no server — $0 mock mode only.
 *
 * Coverage:
 *  - EventBoard: seed marks host; markKnows idempotency; knownBy / knowerCount.
 *  - CognitionSystem.seedEvent: host knows it + gets a high-importance memory +
 *    bus emits event_seeded.
 *  - onTalk diffusion: talking spreads knowledge; listener gets a memory;
 *    talking again does NOT double-add the memory.
 *  - enrichObservation: knownEvents surfaces on obs.self when the agent knows
 *    at least one event; isNow flag is correct.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionType, EventBus, GameStamp, Observation, SimEvent, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { EventBoard } from "../../src/agents/EventBoard";
import { CognitionSystem } from "../../src/agents/Cognition";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeStampBus(): {
  bus: EventBus;
  events: WorldEvent[];
} {
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

function makeAgent(name: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: `${name} — test agent`,
    color: 0xffffff,
    start: pos,
  });
}

function makeEvent(overrides: Partial<SimEvent> = {}): SimEvent {
  return {
    id: "evt-test-1",
    host: "Alice",
    location: { x: 10, y: 5 },
    day: 1,
    phase: "evening",
    description: "a gathering at the tavern",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EventBoard unit tests
// ---------------------------------------------------------------------------

describe("EventBoard", () => {
  it("seed marks the host as knowing the event", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    expect(board.knows(evt.id, evt.host)).toBe(true);
  });

  it("all() returns seeded events", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    expect(board.all()).toHaveLength(1);
    expect(board.all()[0]).toEqual(evt);
  });

  it("get() returns the event by id", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    expect(board.get(evt.id)).toEqual(evt);
    expect(board.get("nonexistent")).toBeUndefined();
  });

  it("markKnows returns true the first time (newly learned), false on repeat", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    // Bob learns it for the first time
    expect(board.markKnows(evt.id, "Bob")).toBe(true);
    // Bob already knows — not new
    expect(board.markKnows(evt.id, "Bob")).toBe(false);
    // Carol learns independently
    expect(board.markKnows(evt.id, "Carol")).toBe(true);
  });

  it("knownBy returns only the events a specific agent knows", () => {
    const board = new EventBoard();
    const e1 = makeEvent({ id: "e1", host: "Alice" });
    const e2 = makeEvent({ id: "e2", host: "Bob" });
    board.seed(e1); // Alice knows e1
    board.seed(e2); // Bob knows e2
    expect(board.knownBy("Alice").map((e) => e.id)).toEqual(["e1"]);
    expect(board.knownBy("Bob").map((e) => e.id)).toEqual(["e2"]);
    board.markKnows("e1", "Bob");
    // Map insertion order: e1 was seeded first, e2 second → both returned for Bob
    expect(board.knownBy("Bob").map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("knowerCount reflects the set size correctly", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt); // host counts
    expect(board.knowerCount(evt.id)).toBe(1);
    board.markKnows(evt.id, "Bob");
    board.markKnows(evt.id, "Carol");
    expect(board.knowerCount(evt.id)).toBe(3);
    // Repeat marks don't inflate
    board.markKnows(evt.id, "Bob");
    expect(board.knowerCount(evt.id)).toBe(3);
    // Unknown event
    expect(board.knowerCount("no-such-id")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CognitionSystem — seedEvent
// ---------------------------------------------------------------------------

describe("CognitionSystem.seedEvent", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let events: WorldEvent[];
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const { bus, events: evts } = makeStampBus();
    events = evts;
    cog = new CognitionSystem({ bus, now: () => now.stamp });
    alice = makeAgent("Alice");
    cog.registerAgent(alice);
  });

  it("host knows the event after seedEvent", () => {
    const evt = makeEvent({ host: "Alice" });
    cog.seedEvent(evt);
    expect(cog.events.knows(evt.id, "Alice")).toBe(true);
  });

  it("host gets a high-importance (8) observation memory mentioning the event", async () => {
    const evt = makeEvent({ host: "Alice" });
    cog.seedEvent(evt);
    // Write is async/fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 10));
    const mems = cog.memory.all("Alice");
    const hostMem = mems.find((m) =>
      m.text.includes("I am hosting") && m.text.includes("gathering at the tavern"),
    );
    expect(hostMem).toBeDefined();
    expect(hostMem!.importance).toBe(8);
  });

  it("emits an event_seeded WorldEvent on the bus", () => {
    const evt = makeEvent({ host: "Alice" });
    cog.seedEvent(evt);
    const seeded = events.find((e) => e.kind === "event_seeded");
    expect(seeded).toBeDefined();
    expect(seeded!.agentName).toBe("Alice");
    expect(seeded!.text).toContain("Alice");
    expect(seeded!.text).toContain("gathering at the tavern");
    expect(seeded!.payload?.eventId).toBe(evt.id);
  });
});

// ---------------------------------------------------------------------------
// CognitionSystem — onTalk diffusion
// ---------------------------------------------------------------------------

describe("CognitionSystem onTalk diffusion", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let bob: Agent;
  let events: WorldEvent[];
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const { bus, events: evts } = makeStampBus();
    events = evts;
    cog = new CognitionSystem({ bus, now: () => now.stamp });
    alice = makeAgent("Alice", { x: 5, y: 5 });
    bob = makeAgent("Bob", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);
  });

  it("Bob learns the event after Alice (knower) talks to him", async () => {
    const evt = makeEvent({ id: "evt-1", host: "Alice" });
    cog.seedEvent(evt);

    // Before the talk, Bob does not know
    expect(cog.events.knows(evt.id, "Bob")).toBe(false);

    cog.onTalk(alice, bob, "Hey, come to the tavern tonight!");
    expect(cog.events.knows(evt.id, "Bob")).toBe(true);

    // Bob gets an observation memory about the event
    await new Promise((r) => setTimeout(r, 10));
    const bobMems = cog.memory.all("Bob");
    const inviteMem = bobMems.find(
      (m) => m.text.includes("Alice told me about") && m.text.includes("gathering at the tavern"),
    );
    expect(inviteMem).toBeDefined();
    expect(inviteMem!.importance).toBe(7);
  });

  it("emits an event_heard WorldEvent when the listener learns the event", () => {
    const evt = makeEvent({ id: "evt-2", host: "Alice" });
    cog.seedEvent(evt);
    cog.onTalk(alice, bob, "Come join us!");

    const heard = events.find(
      (e) => e.kind === "event_heard" && e.agentName === "Bob",
    );
    expect(heard).toBeDefined();
    expect(heard!.text).toContain("Alice invited Bob");
    expect(heard!.payload?.eventId).toBe(evt.id);
    expect(heard!.payload?.from).toBe("Alice");
    expect(heard!.payload?.to).toBe("Bob");
  });

  it("talking again does NOT add a second memory for the same event", async () => {
    const evt = makeEvent({ id: "evt-3", host: "Alice" });
    cog.seedEvent(evt);
    cog.onTalk(alice, bob, "Come tonight!");
    cog.onTalk(alice, bob, "Remember, gathering tonight!");

    await new Promise((r) => setTimeout(r, 10));
    const bobMems = cog.memory
      .all("Bob")
      .filter(
        (m) =>
          m.text.includes("Alice told me about") && m.text.includes("gathering at the tavern"),
      );
    // Only one memory for this event — not duplicated
    expect(bobMems).toHaveLength(1);
  });

  it("knowerCount increases as diffusion propagates", () => {
    const evt = makeEvent({ id: "evt-4", host: "Alice" });
    cog.seedEvent(evt);
    expect(cog.events.knowerCount(evt.id)).toBe(1);
    cog.onTalk(alice, bob, "Come join!");
    expect(cog.events.knowerCount(evt.id)).toBe(2);
  });

  it("non-knower talking to another non-knower does not spread the event", () => {
    const evt = makeEvent({ id: "evt-5", host: "Alice" });
    cog.seedEvent(evt);

    const carol = makeAgent("Carol", { x: 6, y: 5 });
    cog.registerAgent(carol);

    // Bob and Carol talk but neither knows the event
    cog.onTalk(bob, carol, "Nice weather!");
    expect(cog.events.knows(evt.id, "Carol")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CognitionSystem — enrichObservation knownEvents
// ---------------------------------------------------------------------------

describe("CognitionSystem enrichObservation knownEvents", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const { bus } = makeStampBus();
    cog = new CognitionSystem({ bus, now: () => now.stamp });
    alice = makeAgent("Alice");
    cog.registerAgent(alice);
  });

  function makeObs(): Observation {
    return {
      self: {
        name: alice.name,
        persona: alice.persona.description,
        role: alice.role,
        pos: alice.pos,
        energy: alice.energy,
        gold: alice.gold,
        inventory: alice.inventory,
        goal: alice.goal,
      },
      time: now.stamp,
      nearby: { tiles: [], agents: [], landmarks: [] },
      lastAction: null,
      availableActions: [] as ActionType[],
      economy: { sells: {}, buys: {} },
    };
  }

  it("knownEvents is absent when the agent knows no events", async () => {
    const obs = makeObs();
    await cog.enrichObservation(obs, alice);
    expect(obs.self.knownEvents).toBeUndefined();
  });

  it("knownEvents is populated when the agent knows at least one event", async () => {
    const evt = makeEvent({ host: "Alice", day: 1, phase: "evening" });
    cog.seedEvent(evt);
    const obs = makeObs();
    await cog.enrichObservation(obs, alice);
    expect(obs.self.knownEvents).toBeDefined();
    expect(obs.self.knownEvents).toHaveLength(1);
    expect(obs.self.knownEvents![0].id).toBe(evt.id);
    expect(obs.self.knownEvents![0].description).toBe("a gathering at the tavern");
  });

  it("isNow = true when day+phase match current time", async () => {
    now.stamp = { day: 1, phase: "evening" };
    const evt = makeEvent({ host: "Alice", day: 1, phase: "evening" });
    cog.seedEvent(evt);
    const obs = makeObs();
    obs.time = now.stamp;
    await cog.enrichObservation(obs, alice);
    expect(obs.self.knownEvents![0].isNow).toBe(true);
  });

  it("isNow = false when day+phase do not match current time", async () => {
    now.stamp = { day: 1, phase: "morning" };
    const evt = makeEvent({ host: "Alice", day: 1, phase: "evening" });
    cog.seedEvent(evt);
    const obs = makeObs();
    await cog.enrichObservation(obs, alice);
    expect(obs.self.knownEvents![0].isNow).toBe(false);
  });

  it("all event fields are preserved on knownEvents entries", async () => {
    const evt = makeEvent({ host: "Alice" });
    cog.seedEvent(evt);
    const obs = makeObs();
    await cog.enrichObservation(obs, alice);
    const ke = obs.self.knownEvents![0];
    expect(ke.id).toBe(evt.id);
    expect(ke.host).toBe(evt.host);
    expect(ke.location).toEqual(evt.location);
    expect(ke.day).toBe(evt.day);
    expect(ke.phase).toBe(evt.phase);
    expect(ke.description).toBe(evt.description);
  });
});
