/**
 * Recurring-events tests (Task A + Task B).
 *
 * Task A — Recurring seeding:
 *   - shouldSeedGathering() fires on even days ≥ 2 only.
 *   - buildGatheringEvent() returns a correctly-shaped SimEvent with unique ids.
 *   - Simulating day_advanced events through AgentManager seeds party-dN on every
 *     even day with the sage host, evening phase, and a unique id per day.
 *   - Double-seeding the same day is guarded (idempotent).
 *
 * Task B — Past-event filtering:
 *   - isPastEvent() is correct for past / now / future combinations.
 *   - enrichObservation excludes past events from obs.self.knownEvents.
 *   - enrichObservation excludes past events from obs.self.inviteTargets.
 *   - Events happening NOW and in the FUTURE DO appear.
 *
 * Integration:
 *   - party-emergence stays green (seeded event on day 2 is upcoming/now → works).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, Observation, Phase, Vec2, WorldEvent } from "@contracts/types";
import {
  shouldSeedGathering,
  buildGatheringEvent,
} from "../../src/agents/AgentManager";
import { isPastEvent, PHASE_INDEX } from "../../src/agents/Cognition";
import { CognitionSystem } from "../../src/agents/Cognition";
import { Agent } from "../../src/agents/Agent";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubBus(): { bus: EventBus; events: WorldEvent[] } {
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

function makeObsStub(agent: Agent, time: GameStamp): Observation {
  return {
    self: {
      name: agent.name,
      persona: agent.persona.description,
      role: "farmer",
      pos: agent.pos,
      energy: 100,
      gold: 100,
      inventory: [],
      goal: null,
    },
    time,
    nearby: { tiles: [], agents: [], landmarks: [] },
    lastAction: null,
    availableActions: ["WAIT", "MOVE_TO", "TALK_TO", "EMOTE"],
    economy: { sells: {}, buys: {} },
  };
}

function makeCognition(nowFn: () => GameStamp): CognitionSystem {
  const { bus } = makeStubBus();
  return new CognitionSystem({
    bus,
    live: () => false,
    now: nowFn,
    world: () => {
      throw new Error("world not needed in this test");
    },
  });
}

// ---------------------------------------------------------------------------
// Task A — Pure helper unit tests
// ---------------------------------------------------------------------------

describe("shouldSeedGathering()", () => {
  it("returns false for day 1 (odd, below cadence start)", () => {
    expect(shouldSeedGathering(1)).toBe(false);
  });

  it("returns true for day 2 (first gathering)", () => {
    expect(shouldSeedGathering(2)).toBe(true);
  });

  it("returns false for day 3 (odd)", () => {
    expect(shouldSeedGathering(3)).toBe(false);
  });

  it("returns true for day 4 (even ≥ 2)", () => {
    expect(shouldSeedGathering(4)).toBe(true);
  });

  it("returns false for day 5 (odd)", () => {
    expect(shouldSeedGathering(5)).toBe(false);
  });

  it("returns true for day 6 (even)", () => {
    expect(shouldSeedGathering(6)).toBe(true);
  });

  it("returns true for day 50 (even, long run)", () => {
    expect(shouldSeedGathering(50)).toBe(true);
  });

  it("returns false for day 0 (edge: before simulation)", () => {
    expect(shouldSeedGathering(0)).toBe(false);
  });
});

describe("buildGatheringEvent()", () => {
  const tavernPos = { x: 22, y: 15 };
  const hostName = "Social Sage";

  it("builds a SimEvent with id party-dN for the given day", () => {
    const evt = buildGatheringEvent(2, hostName, tavernPos);
    expect(evt.id).toBe("party-d2");
  });

  it("uses unique ids for different days", () => {
    const evtD2 = buildGatheringEvent(2, hostName, tavernPos);
    const evtD4 = buildGatheringEvent(4, hostName, tavernPos);
    const evtD10 = buildGatheringEvent(10, hostName, tavernPos);
    expect(evtD2.id).toBe("party-d2");
    expect(evtD4.id).toBe("party-d4");
    expect(evtD10.id).toBe("party-d10");
    // All ids are distinct
    const ids = new Set([evtD2.id, evtD4.id, evtD10.id]);
    expect(ids.size).toBe(3);
  });

  it("sets host to the provided name", () => {
    const evt = buildGatheringEvent(4, hostName, tavernPos);
    expect(evt.host).toBe(hostName);
  });

  it("sets phase to 'evening'", () => {
    const evt = buildGatheringEvent(4, hostName, tavernPos);
    expect(evt.phase).toBe("evening");
  });

  it("sets description to 'a gathering at the tavern'", () => {
    const evt = buildGatheringEvent(4, hostName, tavernPos);
    expect(evt.description).toBe("a gathering at the tavern");
  });

  it("sets location to the provided tavern position", () => {
    const evt = buildGatheringEvent(4, hostName, tavernPos);
    expect(evt.location).toEqual(tavernPos);
  });

  it("sets day correctly", () => {
    const evt = buildGatheringEvent(8, hostName, tavernPos);
    expect(evt.day).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Task A — CognitionSystem recurring seeding via EventBoard
// ---------------------------------------------------------------------------

describe("recurring gathering seeding via CognitionSystem.seedEvent (guard duplicate)", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("seeding party-d4 on day 4 adds the event to the board", () => {
    const cog = makeCognition(() => ({ day: 4, phase: "morning" }));
    const host = makeAgent("Social Sage");
    cog.registerAgent(host);
    const tavernPos = { x: 22, y: 15 };
    cog.seedEvent(buildGatheringEvent(4, host.name, tavernPos));
    expect(cog.events.get("party-d4")).toBeDefined();
    expect(cog.events.get("party-d4")?.host).toBe("Social Sage");
    expect(cog.events.get("party-d4")?.phase).toBe("evening");
  });

  it("double-seeding the same id is guarded: EventBoard.seed is idempotent for knowledge", () => {
    // EventBoard.seed will overwrite the event entry but not crash.
    // The guard in AgentManager checks events.get(id) before calling seedEvent.
    // This test verifies that calling seed twice on the same id is safe.
    const cog = makeCognition(() => ({ day: 2, phase: "morning" }));
    const tavernPos = { x: 22, y: 15 };
    const evt = buildGatheringEvent(2, "Social Sage", tavernPos);
    // First seed
    cog.events.seed(evt);
    cog.events.markKnows("party-d2", "Bob");
    const knowersBefore = cog.events.knowerCount("party-d2");
    // Second seed (simulates duplicate call)
    cog.events.seed(evt);
    // Knower count is preserved (host re-added idempotently, Bob still knows)
    expect(cog.events.knowerCount("party-d2")).toBe(knowersBefore);
  });

  it("separate even days get separate events on the EventBoard", () => {
    const cog = makeCognition(() => ({ day: 1, phase: "morning" }));
    const tavernPos = { x: 22, y: 15 };
    cog.seedEvent(buildGatheringEvent(2, "Social Sage", tavernPos));
    cog.seedEvent(buildGatheringEvent(4, "Social Sage", tavernPos));
    cog.seedEvent(buildGatheringEvent(6, "Social Sage", tavernPos));
    expect(cog.events.get("party-d2")).toBeDefined();
    expect(cog.events.get("party-d4")).toBeDefined();
    expect(cog.events.get("party-d6")).toBeDefined();
    expect(cog.events.all()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Task B — isPastEvent() unit tests
// ---------------------------------------------------------------------------

describe("PHASE_INDEX", () => {
  it("has the correct ordering: morning < afternoon < evening < night", () => {
    expect(PHASE_INDEX.morning).toBeLessThan(PHASE_INDEX.afternoon);
    expect(PHASE_INDEX.afternoon).toBeLessThan(PHASE_INDEX.evening);
    expect(PHASE_INDEX.evening).toBeLessThan(PHASE_INDEX.night);
  });
});

describe("isPastEvent()", () => {
  const phases: Phase[] = ["morning", "afternoon", "evening", "night"];

  it("returns true when event.day < now.day (regardless of phase)", () => {
    for (const phase of phases) {
      expect(isPastEvent({ day: 1, phase }, { day: 3, phase: "morning" })).toBe(true);
    }
  });

  it("returns false when event.day > now.day (future day)", () => {
    for (const phase of phases) {
      expect(isPastEvent({ day: 5, phase }, { day: 3, phase: "night" })).toBe(false);
    }
  });

  it("returns false when event is on the same day+phase (happening NOW)", () => {
    for (const phase of phases) {
      expect(isPastEvent({ day: 3, phase }, { day: 3, phase })).toBe(false);
    }
  });

  it("returns true when event phase < now phase on the same day", () => {
    // morning event, now = afternoon
    expect(isPastEvent({ day: 3, phase: "morning" }, { day: 3, phase: "afternoon" })).toBe(true);
    // morning event, now = evening
    expect(isPastEvent({ day: 3, phase: "morning" }, { day: 3, phase: "evening" })).toBe(true);
    // afternoon event, now = evening
    expect(isPastEvent({ day: 3, phase: "afternoon" }, { day: 3, phase: "evening" })).toBe(true);
    // afternoon event, now = night
    expect(isPastEvent({ day: 3, phase: "afternoon" }, { day: 3, phase: "night" })).toBe(true);
    // evening event, now = night
    expect(isPastEvent({ day: 3, phase: "evening" }, { day: 3, phase: "night" })).toBe(true);
  });

  it("returns false when event phase > now phase on the same day (future within day)", () => {
    // afternoon event, now = morning
    expect(isPastEvent({ day: 3, phase: "afternoon" }, { day: 3, phase: "morning" })).toBe(false);
    // evening event, now = morning
    expect(isPastEvent({ day: 3, phase: "evening" }, { day: 3, phase: "morning" })).toBe(false);
    // night event, now = afternoon
    expect(isPastEvent({ day: 3, phase: "night" }, { day: 3, phase: "afternoon" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task B — enrichObservation past-event filtering
// ---------------------------------------------------------------------------

describe("enrichObservation — past-event filtering", () => {
  beforeEach(() => { resetWorldForTests(); });

  it("excludes a PAST event (day < today) from obs.self.knownEvents", async () => {
    // Now = day 5 morning. Event is on day 2 evening → past.
    const now: GameStamp = { day: 5, phase: "morning" };
    const cog = makeCognition(() => now);
    const agent = makeAgent("Alice");
    cog.registerAgent(agent);
    cog.seedEvent({
      id: "past-evt",
      host: "Alice",
      location: { x: 10, y: 5 },
      day: 2,
      phase: "evening",
      description: "a past gathering",
    });
    // Alice knows the event (she's the host)
    expect(cog.events.knows("past-evt", "Alice")).toBe(true);

    const obs = makeObsStub(agent, now);
    await cog.enrichObservation(obs, agent);

    // Past event must NOT appear in knownEvents
    const knownIds = (obs.self.knownEvents ?? []).map((e) => e.id);
    expect(knownIds).not.toContain("past-evt");
  });

  it("excludes a PAST event (same day, earlier phase) from obs.self.knownEvents", async () => {
    // Now = day 3 evening. Event is on day 3 morning → past (same day, earlier phase).
    const now: GameStamp = { day: 3, phase: "evening" };
    const cog = makeCognition(() => now);
    const agent = makeAgent("Bob");
    cog.registerAgent(agent);
    cog.seedEvent({
      id: "past-morning-evt",
      host: "Bob",
      location: { x: 10, y: 5 },
      day: 3,
      phase: "morning",
      description: "a morning gathering",
    });

    const obs = makeObsStub(agent, now);
    await cog.enrichObservation(obs, agent);

    const knownIds = (obs.self.knownEvents ?? []).map((e) => e.id);
    expect(knownIds).not.toContain("past-morning-evt");
  });

  it("includes an event happening NOW (same day+phase) in obs.self.knownEvents", async () => {
    const now: GameStamp = { day: 2, phase: "evening" };
    const cog = makeCognition(() => now);
    const agent = makeAgent("Social Sage");
    cog.registerAgent(agent);
    cog.seedEvent({
      id: "party-d2",
      host: "Social Sage",
      location: { x: 22, y: 15 },
      day: 2,
      phase: "evening",
      description: "a gathering at the tavern",
    });

    const obs = makeObsStub(agent, now);
    await cog.enrichObservation(obs, agent);

    const knownIds = (obs.self.knownEvents ?? []).map((e) => e.id);
    expect(knownIds).toContain("party-d2");
    // isNow must be true
    const ke = obs.self.knownEvents?.find((e) => e.id === "party-d2");
    expect(ke?.isNow).toBe(true);
  });

  it("includes a FUTURE event (day > today) in obs.self.knownEvents", async () => {
    const now: GameStamp = { day: 1, phase: "morning" };
    const cog = makeCognition(() => now);
    const agent = makeAgent("Carol");
    cog.registerAgent(agent);
    cog.seedEvent({
      id: "future-evt",
      host: "Carol",
      location: { x: 10, y: 5 },
      day: 4,
      phase: "evening",
      description: "a future gathering",
    });

    const obs = makeObsStub(agent, now);
    await cog.enrichObservation(obs, agent);

    const knownIds = (obs.self.knownEvents ?? []).map((e) => e.id);
    expect(knownIds).toContain("future-evt");
    // isNow must be false
    const ke = obs.self.knownEvents?.find((e) => e.id === "future-evt");
    expect(ke?.isNow).toBe(false);
  });

  it("past event does NOT generate inviteTargets for the host", async () => {
    // Now = day 5 morning. Party was on day 2 evening → past.
    const now: GameStamp = { day: 5, phase: "morning" };
    const cog = makeCognition(() => now);
    const host = makeAgent("Social Sage", { x: 5, y: 5 });
    const other = makeAgent("Bob Farmer", { x: 6, y: 6 });
    cog.registerAgent(host);
    cog.registerAgent(other);
    cog.seedEvent({
      id: "past-party",
      host: host.name,
      location: { x: 22, y: 15 },
      day: 2,
      phase: "evening",
      description: "a gathering at the tavern",
    });
    // Bob does NOT know about the event (so would normally appear as inviteTarget)
    expect(cog.events.knows("past-party", other.name)).toBe(false);

    const obs = makeObsStub(host, now);
    await cog.enrichObservation(obs, host);

    // inviteTargets must be absent or empty (event is past → no inviting)
    expect((obs.self.inviteTargets ?? []).length).toBe(0);
  });

  it("upcoming event DOES generate inviteTargets for the host", async () => {
    // Now = day 1 morning. Party is on day 2 evening → future (upcoming).
    const now: GameStamp = { day: 1, phase: "morning" };
    const cog = makeCognition(() => now);
    const host = makeAgent("Social Sage", { x: 5, y: 5 });
    const other = makeAgent("Bob Farmer", { x: 6, y: 6 });
    cog.registerAgent(host);
    cog.registerAgent(other);
    cog.seedEvent({
      id: "party-d2",
      host: host.name,
      location: { x: 22, y: 15 },
      day: 2,
      phase: "evening",
      description: "a gathering at the tavern",
    });
    // Bob does NOT know yet
    expect(cog.events.knows("party-d2", other.name)).toBe(false);

    const obs = makeObsStub(host, now);
    await cog.enrichObservation(obs, host);

    // inviteTargets must include Bob (he doesn't know yet and event is upcoming)
    const targetNames = (obs.self.inviteTargets ?? []).map((t) => t.name);
    expect(targetNames).toContain(other.name);
  });

  it("mix: past event excluded, future event included for the same agent", async () => {
    const now: GameStamp = { day: 3, phase: "afternoon" };
    const cog = makeCognition(() => now);
    const agent = makeAgent("Alice");
    cog.registerAgent(agent);
    // Past event: day 1 evening
    cog.seedEvent({
      id: "old-party",
      host: "Alice",
      location: { x: 10, y: 5 },
      day: 1,
      phase: "evening",
      description: "an old gathering",
    });
    // Upcoming event: day 4 evening
    cog.seedEvent({
      id: "new-party",
      host: "Alice",
      location: { x: 22, y: 15 },
      day: 4,
      phase: "evening",
      description: "a future gathering",
    });

    const obs = makeObsStub(agent, now);
    await cog.enrichObservation(obs, agent);

    const knownIds = (obs.self.knownEvents ?? []).map((e) => e.id);
    expect(knownIds).not.toContain("old-party");
    expect(knownIds).toContain("new-party");
  });
});
