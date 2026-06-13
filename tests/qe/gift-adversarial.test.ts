/**
 * QE v2 — GIVE_GIFT adversarial battery against the §4.4 v2 row (rule 8) and
 * the cognition seam (rule 9 + AFFINITY_DELTAS):
 *
 *  - hostile targets (non-adjacent, DIAGONAL, absent item, qty 0/-1/NaN/
 *    Infinity/1.5, self, unknown agent, malformed shapes) all reject loudly
 *    with reasons and leave the world byte-identical;
 *  - a valid gift transfers EXACTLY 1 (even when qty asks for more — the
 *    contract pins the transfer at 1), updates both inventories, writes an
 *    importance-7 memory for BOTH sides and recordInteraction in EACH
 *    direction (+10 affinity per the contract table);
 *  - affinity clamps at ±100.
 *
 * Note: TALK_TO range is Chebyshev-1 (diagonal OK) while GIVE_GIFT is
 * 4-adjacent — the diagonal case is exactly the seam a sloppy merge of the
 * two checks would get wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, WorldEvent } from "@contracts/types";
import { AFFINITY_DELTAS } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { executeAction } from "../../src/agents/ActionExecutor";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem, GIFT_IMPORTANCE } from "../../src/agents/Cognition";
import { clampAffinity } from "../../src/agents/Relationships";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";

let giver: Agent;
let receiver: Agent;
let cognition: CognitionSystem;
let events: WorldEvent[];

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
  // (3,7) and (3,8) are grass, vertically 4-adjacent (map.ts layout).
  giver = new Agent({
    id: "g",
    name: "Giver",
    description: "a generous test farmer",
    color: 0x111111,
    start: { x: 3, y: 7 },
  });
  receiver = new Agent({
    id: "r",
    name: "Receiver",
    description: "a lucky test farmer",
    color: 0x222222,
    start: { x: 3, y: 8 },
  });
  cognition = new CognitionSystem({ bus: getEventBus(), modelMode: "mock" });
  cognition.registerAgent(giver);
  cognition.registerAgent(receiver);
  events = [];
  getEventBus().on((e) => events.push(e));
});

afterEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
});

/** Drain the fire-and-forget memory writes (microtasks + setTimeout(0)). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function snapshot(): string {
  return JSON.stringify({
    giver: {
      inv: giver.inventory,
      gold: giver.gold,
      energy: giver.energy,
      pos: giver.pos,
    },
    receiver: {
      inv: receiver.inventory,
      gold: receiver.gold,
      energy: receiver.energy,
      pos: receiver.pos,
    },
    relsG: cognition.relationships.allFor("Giver"),
    relsR: cognition.relationships.allFor("Receiver"),
  });
}

function gift(target: unknown): AgentAction {
  return {
    thought: "t",
    say: null,
    action: "GIVE_GIFT",
    target: target as AgentAction["target"],
  };
}

async function run(action: AgentAction, others: Agent[] = [receiver]) {
  return executeAction(giver, action, getWorld(), others, { cognition });
}

describe("GIVE_GIFT — hostile inputs reject loudly, world unchanged", () => {
  it("non-adjacent receiver (3 tiles away) rejects with a distance reason", async () => {
    receiver.pos = { x: 6, y: 7 };
    const before = snapshot();
    const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too far/i);
    await flush();
    expect(snapshot()).toBe(before);
  });

  it("DIAGONAL receiver rejects: gift is 4-adjacency, not Chebyshev (TALK_TO would allow it)", async () => {
    receiver.pos = { x: 4, y: 8 }; // Chebyshev 1 from (3,7), Manhattan 2
    const before = snapshot();
    const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too far|next to/i);
    await flush();
    expect(snapshot()).toBe(before);

    // sanity: the SAME positions allow TALK_TO (Chebyshev-1 contract row)
    const talk = await run({
      thought: "t",
      say: "hello!",
      action: "TALK_TO",
      target: { agentName: "Receiver" },
    });
    expect(talk.ok).toBe(true);
  });

  it("absent item rejects (giver holds no crop:parsnip)", async () => {
    const before = snapshot();
    const r = await run(gift({ agentName: "Receiver", itemId: "crop:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/do not have/i);
    await flush();
    expect(snapshot()).toBe(before);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["fractional", 1.5],
  ])("hostile qty (%s = %s) rejects with the whole-number reason", async (_label, qty) => {
    const before = snapshot();
    const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/whole number|needs an/i);
    await flush();
    expect(snapshot()).toBe(before);
    expect(events.filter((e) => e.kind === "relationship_updated")).toHaveLength(0);
  });

  it("gifting to yourself rejects, even when the others list is polluted with self", async () => {
    const before = snapshot();
    const r = await run(
      gift({ agentName: "Giver", itemId: "seed:parsnip", qty: 1 }),
      [receiver, giver], // adversarial: self present in others
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no agent named/i);
    await flush();
    expect(snapshot()).toBe(before);
  });

  it("unknown receiver rejects", async () => {
    const before = snapshot();
    const r = await run(gift({ agentName: "Nobody", itemId: "seed:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no agent named/i);
    await flush();
    expect(snapshot()).toBe(before);
  });

  it.each([
    ["undefined", undefined],
    ["empty object", {}],
    ["numeric agentName", { agentName: 5, itemId: "seed:parsnip", qty: 1 }],
    ["missing itemId", { agentName: "Receiver", qty: 1 }],
    ["qty as string", { agentName: "Receiver", itemId: "seed:parsnip", qty: "1" }],
    ["vec2 target", { x: 3, y: 8 }],
  ])("malformed target (%s) rejects with the shape reason", async (_label, target) => {
    const before = snapshot();
    const r = await run(gift(target));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs an \{agentName, itemId, qty\}/);
    await flush();
    expect(snapshot()).toBe(before);
  });

  it("no memory was written and no affinity moved across the whole hostile battery", async () => {
    for (const t of [
      { agentName: "Receiver", itemId: "seed:parsnip", qty: 0 },
      { agentName: "Receiver", itemId: "crop:parsnip", qty: 1 },
      { agentName: "Nobody", itemId: "seed:parsnip", qty: 1 },
    ]) {
      await run(gift(t));
    }
    await flush();
    expect(cognition.memory.all("Giver")).toHaveLength(0);
    expect(cognition.memory.all("Receiver")).toHaveLength(0);
    expect(cognition.relationships.get("Giver", "Receiver")).toBeNull();
    expect(cognition.relationships.get("Receiver", "Giver")).toBeNull();
  });
});

describe("GIVE_GIFT — valid gift: exact transfer + both-sides cognition", () => {
  it("transfers exactly 1, both inventories correct, +10 affinity EACH direction, importance-7 memories BOTH sides", async () => {
    const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty: 1 }));
    expect(r).toEqual({ ok: true });
    await flush();

    // Inventory: exactly 1 moved, total conserved.
    expect(giver.countItem("seed:parsnip")).toBe(4);
    expect(receiver.countItem("seed:parsnip")).toBe(6); // 5 starting + 1
    expect(giver.energy).toBe(100); // GIVE_GIFT costs 0 energy (kickoff table)
    expect(giver.gold).toBe(200);
    expect(receiver.gold).toBe(200);

    // Contract table: recordInteraction EACH direction, +10 per the table.
    expect(AFFINITY_DELTAS.GIVE_GIFT).toBe(10);
    const gToR = cognition.relationships.get("Giver", "Receiver");
    const rToG = cognition.relationships.get("Receiver", "Giver");
    expect(gToR?.affinity).toBe(10);
    expect(rToG?.affinity).toBe(10);
    expect(gToR?.interactions).toBe(1);
    expect(rToG?.interactions).toBe(1);

    const relEvents = events.filter((e) => e.kind === "relationship_updated");
    expect(relEvents).toHaveLength(2); // one per direction
    expect(new Set(relEvents.map((e) => e.agentName))).toEqual(
      new Set(["Giver", "Receiver"]),
    );
    for (const e of relEvents) expect(e.payload?.delta).toBe(10);

    // Rule 9: high-importance (7) gift memory for BOTH sides.
    const giverMem = cognition.memory.all("Giver");
    const recvMem = cognition.memory.all("Receiver");
    expect(giverMem).toHaveLength(1);
    expect(recvMem).toHaveLength(1);
    expect(giverMem[0].importance).toBe(GIFT_IMPORTANCE);
    expect(recvMem[0].importance).toBe(GIFT_IMPORTANCE);
    expect(giverMem[0].text).toContain("I gave Receiver 1 seed:parsnip");
    expect(recvMem[0].text).toContain("Giver gave me 1 seed:parsnip");
    expect(giverMem[0].type).toBe("observation");
  });

  it("qty 5 still transfers EXACTLY 1 (the contract pins the transfer at 1)", async () => {
    const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty: 5 }));
    expect(r.ok).toBe(true);
    expect(giver.countItem("seed:parsnip")).toBe(4); // not 0
    expect(receiver.countItem("seed:parsnip")).toBe(6); // not 10
  });

  it("the last held item can be gifted and the entry disappears cleanly", async () => {
    giver.inventory = [{ itemId: "crop:potato", qty: 1 }];
    const r = await run(gift({ agentName: "Receiver", itemId: "crop:potato", qty: 1 }));
    expect(r.ok).toBe(true);
    expect(giver.inventory.find((i) => i.itemId === "crop:potato")).toBeUndefined();
    expect(receiver.countItem("crop:potato")).toBe(1);

    // ...and a second attempt now rejects (nothing left), state unchanged.
    const r2 = await run(gift({ agentName: "Receiver", itemId: "crop:potato", qty: 1 }));
    expect(r2.ok).toBe(false);
    expect(receiver.countItem("crop:potato")).toBe(1);
  });
});

describe("affinity clamping and TALK_TO delta", () => {
  it("15 gifts clamp affinity at +100 (never 150)", async () => {
    giver.inventory = [{ itemId: "seed:parsnip", qty: 20 }];
    for (let i = 0; i < 15; i++) {
      const r = await run(gift({ agentName: "Receiver", itemId: "seed:parsnip", qty: 1 }));
      expect(r.ok).toBe(true);
    }
    await flush();
    expect(cognition.relationships.get("Giver", "Receiver")?.affinity).toBe(100);
    expect(cognition.relationships.get("Receiver", "Giver")?.affinity).toBe(100);
    // every emitted affinity stayed in [-100, 100]
    for (const e of events.filter((x) => x.kind === "relationship_updated")) {
      const a = e.payload?.affinity as number;
      expect(Math.abs(a)).toBeLessThanOrEqual(100);
    }
    expect(clampAffinity(150)).toBe(100);
    expect(clampAffinity(-150)).toBe(-100);
  });

  it("TALK_TO moves affinity by the contract +2, both directions", async () => {
    expect(AFFINITY_DELTAS.TALK_TO).toBe(2);
    const r = await run({
      thought: "t",
      say: "lovely weather",
      action: "TALK_TO",
      target: { agentName: "Receiver" },
    });
    expect(r.ok).toBe(true);
    await flush();
    expect(cognition.relationships.get("Giver", "Receiver")?.affinity).toBe(2);
    expect(cognition.relationships.get("Receiver", "Giver")?.affinity).toBe(2);
  });
});
