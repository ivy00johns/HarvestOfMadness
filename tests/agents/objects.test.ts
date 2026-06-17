/**
 * Object affordances (v3) — world objects (well, notice_board, bench),
 * USE_OBJECT action, nearby.objects population, notice-board diffusion.
 *
 * Covers:
 *  - World exposes exactly 3 objects (well, notice_board, bench)
 *  - nearby.objects is populated when objects are within OBSERVATION_RADIUS
 *  - USE_OBJECT is available only when adjacent to a usable object
 *  - Executor: USE_OBJECT on the well / bench → ok + memory (via cognition hook)
 *  - Executor: USE_OBJECT when not adjacent → rejected
 *  - Executor: USE_OBJECT with unknown objectId → rejected
 *  - Notice-board diffusion: USE_OBJECT on notice_board when an active event is
 *    seeded-but-unknown → agent now knows the event + gets a memory
 *  - activityEmoji has a USE_OBJECT entry
 *  - ENERGY_COSTS has USE_OBJECT
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, SimEvent, Vec2 } from "@contracts/types";
import { ENERGY_COSTS } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { BENCH_POS, NOTICE_BOARD_POS, WELL_POS, WORLD_OBJECTS } from "../../src/world/map";
import { Agent } from "../../src/agents/Agent";
import { buildObservation, computeAvailableActions } from "../../src/agents/Observation";
import { executeAction } from "../../src/agents/ActionExecutor";
import { CognitionSystem } from "../../src/agents/Cognition";
import { activityEmoji } from "../../src/obs/activityEmoji";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(pos: Vec2, name = "Tester"): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: "a test farmer",
    color: 0xffffff,
    start: pos,
  });
}

function act(action: AgentAction["action"], target?: AgentAction["target"]): AgentAction {
  return { thought: "t", say: null, action, ...(target !== undefined ? { target } : {}) };
}

const OPTS = { msPerTile: 0 };

function exec(agent: Agent, action: AgentAction, opts = OPTS) {
  return executeAction(agent, action, getWorld(), [], opts);
}

// One tile adjacent to each object.
// WELL at (19,16) → approach from the north (19,15)
// NOTICE_BOARD at (20,16) → approach from the south (20,17) — avoids the well at (19,16)
// BENCH at (29,10) → approach from the left (28,10)
const NEXT_TO_WELL: Vec2 = { x: WELL_POS.x, y: WELL_POS.y - 1 };
const NEXT_TO_BOARD: Vec2 = { x: NOTICE_BOARD_POS.x, y: NOTICE_BOARD_POS.y + 1 };
const NEXT_TO_BENCH: Vec2 = { x: BENCH_POS.x - 1, y: BENCH_POS.y };

beforeEach(() => {
  resetWorldForTests();
});

// ---------------------------------------------------------------------------
// World.objects()
// ---------------------------------------------------------------------------

describe("World.objects()", () => {
  it("returns exactly 3 objects", () => {
    const world = getWorld();
    expect(world.objects()).toHaveLength(3);
  });

  it("includes well, notice_board, and bench", () => {
    const world = getWorld();
    const kinds = world.objects().map((o) => o.kind).sort();
    expect(kinds).toEqual(["bench", "notice_board", "well"]);
  });

  it("returns a defensive copy — mutating the result does not affect the world", () => {
    const world = getWorld();
    const copy = world.objects();
    copy[0].pos.x = -999;
    expect(world.objects()[0].pos.x).not.toBe(-999);
  });

  it("matches WORLD_OBJECTS from map.ts", () => {
    const world = getWorld();
    const fromWorld = world.objects();
    expect(fromWorld).toHaveLength(WORLD_OBJECTS.length);
    for (const obj of WORLD_OBJECTS) {
      const found = fromWorld.find((o) => o.id === obj.id);
      expect(found).toBeDefined();
      expect(found?.kind).toBe(obj.kind);
      expect(found?.pos).toEqual(obj.pos);
    }
  });
});

// ---------------------------------------------------------------------------
// World.adjacentObject()
// ---------------------------------------------------------------------------

describe("World.adjacentObject()", () => {
  it("returns an object when the agent is adjacent (4-neighbor)", () => {
    const world = getWorld();
    const obj = world.adjacentObject(NEXT_TO_WELL);
    expect(obj).not.toBeNull();
    expect(obj?.kind).toBe("well");
  });

  it("returns an object when the agent is on the same tile", () => {
    const world = getWorld();
    const obj = world.adjacentObject(WELL_POS);
    expect(obj).not.toBeNull();
    expect(obj?.kind).toBe("well");
  });

  it("returns null when no object is adjacent", () => {
    const world = getWorld();
    // Middle of the map, far from all objects
    const obj = world.adjacentObject({ x: 5, y: 5 });
    expect(obj).toBeNull();
  });

  it("finds notice_board when adjacent", () => {
    const world = getWorld();
    const obj = world.adjacentObject(NEXT_TO_BOARD);
    expect(obj?.kind).toBe("notice_board");
  });

  it("finds bench when adjacent", () => {
    const world = getWorld();
    const obj = world.adjacentObject(NEXT_TO_BENCH);
    expect(obj?.kind).toBe("bench");
  });
});

// ---------------------------------------------------------------------------
// Observation.nearby.objects
// ---------------------------------------------------------------------------

describe("Observation.nearby.objects", () => {
  it("is populated when an object is within OBSERVATION_RADIUS", () => {
    // NEXT_TO_WELL is 1 tile from the well, within radius 4
    const agent = makeAgent(NEXT_TO_WELL);
    const obs = buildObservation(agent, getWorld(), []);
    expect(obs.nearby.objects).toBeDefined();
    expect(obs.nearby.objects!.some((o) => o.kind === "well")).toBe(true);
  });

  it("is absent (or empty) when no objects are nearby", () => {
    // (5,5) is far from all objects
    const agent = makeAgent({ x: 5, y: 5 });
    const obs = buildObservation(agent, getWorld(), []);
    // Either undefined or empty array is acceptable
    expect(!obs.nearby.objects || obs.nearby.objects.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeAvailableActions — USE_OBJECT gating
// ---------------------------------------------------------------------------

describe("computeAvailableActions — USE_OBJECT", () => {
  it("includes USE_OBJECT when adjacent to the well", () => {
    const agent = makeAgent(NEXT_TO_WELL);
    const actions = computeAvailableActions(agent, getWorld(), []);
    expect(actions).toContain("USE_OBJECT");
  });

  it("includes USE_OBJECT when adjacent to the notice board", () => {
    const agent = makeAgent(NEXT_TO_BOARD);
    const actions = computeAvailableActions(agent, getWorld(), []);
    expect(actions).toContain("USE_OBJECT");
  });

  it("includes USE_OBJECT when adjacent to the bench", () => {
    const agent = makeAgent(NEXT_TO_BENCH);
    const actions = computeAvailableActions(agent, getWorld(), []);
    expect(actions).toContain("USE_OBJECT");
  });

  it("does NOT include USE_OBJECT when not adjacent to any object", () => {
    const agent = makeAgent({ x: 5, y: 5 });
    const actions = computeAvailableActions(agent, getWorld(), []);
    expect(actions).not.toContain("USE_OBJECT");
  });

  it("does NOT include USE_OBJECT at energy 0 (energy floor)", () => {
    const agent = makeAgent(NEXT_TO_WELL);
    agent.energy = 0;
    const actions = computeAvailableActions(agent, getWorld(), []);
    expect(actions).not.toContain("USE_OBJECT");
  });
});

// ---------------------------------------------------------------------------
// Executor: USE_OBJECT — ok paths
// ---------------------------------------------------------------------------

describe("Executor: USE_OBJECT ok paths", () => {
  it("USE_OBJECT on the well when adjacent → ok", async () => {
    const agent = makeAgent(NEXT_TO_WELL);
    const result = await exec(agent, act("USE_OBJECT", { objectId: "well" }));
    expect(result.ok).toBe(true);
  });

  it("USE_OBJECT on the bench when adjacent → ok", async () => {
    const agent = makeAgent(NEXT_TO_BENCH);
    const result = await exec(agent, act("USE_OBJECT", { objectId: "bench" }));
    expect(result.ok).toBe(true);
  });

  it("USE_OBJECT on the notice_board when adjacent → ok", async () => {
    const agent = makeAgent(NEXT_TO_BOARD);
    const result = await exec(agent, act("USE_OBJECT", { objectId: "notice_board" }));
    expect(result.ok).toBe(true);
  });

  it("USE_OBJECT without objectId when adjacent to an object → ok (fallback)", async () => {
    const agent = makeAgent(NEXT_TO_WELL);
    // No target provided — should find well automatically
    const result = await exec(agent, act("USE_OBJECT"));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Executor: USE_OBJECT — rejection paths
// ---------------------------------------------------------------------------

describe("Executor: USE_OBJECT rejection paths", () => {
  it("rejected when not adjacent to the named object", async () => {
    const agent = makeAgent({ x: 5, y: 5 }); // far from all objects
    const result = await exec(agent, act("USE_OBJECT", { objectId: "well" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/adjacent/i);
  });

  it("rejected with unknown objectId", async () => {
    const agent = makeAgent(NEXT_TO_WELL);
    const result = await exec(agent, act("USE_OBJECT", { objectId: "nonexistent_object" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no world object/i);
  });

  it("rejected when adjacent to well but targeting notice_board far away", async () => {
    const agent = makeAgent(NEXT_TO_WELL);
    // Notice board is one tile east of well, so not adjacent to agent
    const result = await exec(agent, act("USE_OBJECT", { objectId: "notice_board" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/adjacent/i);
  });
});

// ---------------------------------------------------------------------------
// Cognition: onUseObject — memory + notice-board diffusion
// ---------------------------------------------------------------------------

describe("CognitionSystem.onUseObject — memory writing", () => {
  it("well interaction writes a memory", async () => {
    const agent = makeAgent(NEXT_TO_WELL, "Dora");
    const cognition = new CognitionSystem({ modelMode: "mock" });
    cognition.registerAgent(agent);
    cognition.onUseObject(agent, "well", "well");
    // Give the async write time to settle
    await new Promise((r) => setTimeout(r, 20));
    const memories = cognition.memory.all("Dora");
    expect(memories.some((m) => m.text.toLowerCase().includes("well"))).toBe(true);
  });

  it("bench interaction writes a memory", async () => {
    const agent = makeAgent(NEXT_TO_BENCH, "Gus");
    const cognition = new CognitionSystem({ modelMode: "mock" });
    cognition.registerAgent(agent);
    cognition.onUseObject(agent, "bench", "bench");
    await new Promise((r) => setTimeout(r, 20));
    const memories = cognition.memory.all("Gus");
    expect(memories.some((m) => m.text.toLowerCase().includes("bench"))).toBe(true);
  });

  it("notice_board interaction writes a memory", async () => {
    const agent = makeAgent(NEXT_TO_BOARD, "Fern");
    const cognition = new CognitionSystem({ modelMode: "mock" });
    cognition.registerAgent(agent);
    cognition.onUseObject(agent, "notice_board", "notice_board");
    await new Promise((r) => setTimeout(r, 20));
    const memories = cognition.memory.all("Fern");
    expect(memories.some((m) => m.text.toLowerCase().includes("notice board"))).toBe(true);
  });
});

describe("CognitionSystem.onUseObject — notice-board event diffusion", () => {
  it("reading the notice board teaches an unknown active event to the agent", async () => {
    const agent = makeAgent(NEXT_TO_BOARD, "Sage");
    const cognition = new CognitionSystem({ modelMode: "mock" });
    cognition.registerAgent(agent);

    // Seed an active event (day 1 morning = current/future)
    const event: SimEvent = {
      id: "test-party-1",
      host: "Dora",
      location: { x: 22, y: 15 },
      day: 1,
      phase: "evening",
      description: "a gathering at the tavern",
    };
    cognition.seedEvent(event);

    // Sage does NOT yet know the event
    expect(cognition.events.knows("test-party-1", "Sage")).toBe(false);

    // Sage uses the notice board
    cognition.onUseObject(agent, "notice_board", "notice_board");
    await new Promise((r) => setTimeout(r, 20));

    // Sage now knows the event (diffusion)
    expect(cognition.events.knows("test-party-1", "Sage")).toBe(true);

    // Sage has a memory about the announcement
    const memories = cognition.memory.all("Sage");
    expect(
      memories.some(
        (m) =>
          m.text.toLowerCase().includes("notice board") &&
          m.text.toLowerCase().includes("gathering"),
      ),
    ).toBe(true);
  });

  it("does NOT teach a past event via the notice board", async () => {
    const agent = makeAgent(NEXT_TO_BOARD, "Wren");
    const cognition = new CognitionSystem({
      modelMode: "mock",
      now: () => ({ day: 2, phase: "morning" }), // current time: day 2 morning
    });
    cognition.registerAgent(agent);

    // Seed a PAST event (day 1, morning is past relative to day 2 morning)
    const pastEvent: SimEvent = {
      id: "old-party-1",
      host: "Dora",
      location: { x: 22, y: 15 },
      day: 1,
      phase: "evening",
      description: "a past gathering at the tavern",
    };
    cognition.seedEvent(pastEvent);
    expect(cognition.events.knows("old-party-1", "Wren")).toBe(false);

    cognition.onUseObject(agent, "notice_board", "notice_board");
    await new Promise((r) => setTimeout(r, 20));

    // Past event should NOT be taught
    expect(cognition.events.knows("old-party-1", "Wren")).toBe(false);
  });

  it("does NOT re-teach an already-known event", async () => {
    const agent = makeAgent(NEXT_TO_BOARD, "Moss");
    const cognition = new CognitionSystem({ modelMode: "mock" });
    cognition.registerAgent(agent);

    const event: SimEvent = {
      id: "test-party-2",
      host: "Dora",
      location: { x: 22, y: 15 },
      day: 1,
      phase: "evening",
      description: "a future gathering",
    };
    cognition.seedEvent(event);
    // Pre-mark Moss as knowing it
    cognition.events.markKnows("test-party-2", "Moss");
    expect(cognition.events.knows("test-party-2", "Moss")).toBe(true);

    // Use the notice board
    cognition.onUseObject(agent, "notice_board", "notice_board");
    await new Promise((r) => setTimeout(r, 20));

    // Still knows it (no duplicate teaching)
    expect(cognition.events.knows("test-party-2", "Moss")).toBe(true);
    // Memory count should be exactly 1 notice-board memory (not double)
    const memories = cognition.memory.all("Moss");
    const boardMemories = memories.filter((m) => m.text.toLowerCase().includes("notice board"));
    expect(boardMemories.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// activityEmoji — USE_OBJECT
// ---------------------------------------------------------------------------

describe("activityEmoji USE_OBJECT", () => {
  it("returns a non-empty string for USE_OBJECT", () => {
    const emoji = activityEmoji("USE_OBJECT");
    expect(typeof emoji).toBe("string");
    expect(emoji.length).toBeGreaterThan(0);
  });

  it("USE_OBJECT emoji is ✨", () => {
    expect(activityEmoji("USE_OBJECT")).toBe("✨");
  });
});

// ---------------------------------------------------------------------------
// ENERGY_COSTS — USE_OBJECT
// ---------------------------------------------------------------------------

describe("ENERGY_COSTS.USE_OBJECT", () => {
  it("is defined and is 0 (free action)", () => {
    expect(ENERGY_COSTS.USE_OBJECT).toBe(0);
  });
});
