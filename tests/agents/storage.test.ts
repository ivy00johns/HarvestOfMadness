/**
 * Living Homes #2 — home-storage DEPOSIT/WITHDRAW mechanic.
 *
 * An agent standing on its bed tile (its home) can DEPOSIT goods from
 * `inventory` into a per-agent `homeStorage` and WITHDRAW them back. Bed-tile
 * gated (same anchor as SLEEP); goods are conserved (qty in == qty out).
 *
 * Mirrors executor.test.ts: real World via resetWorldForTests, makeAgent/act/exec.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, Vec2 } from "@contracts/types";
import { ENERGY_START } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { BED_POS, FIELD_RECT } from "../../src/world/map";
import { Agent } from "../../src/agents/Agent";
import { executeAction } from "../../src/agents/ActionExecutor";

// Standing tile away from any bed (first homestead's plot soil).
const FARM_STAND: Vec2 = { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 + 1 };

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

function exec(agent: Agent, action: AgentAction, others: Agent[] = []) {
  return executeAction(agent, action, getWorld(), others, OPTS);
}

beforeEach(() => {
  resetWorldForTests();
});

describe("Agent storage helpers (mirror inventory semantics)", () => {
  it("addToStorage / storageCount: happy path, merges and ignores non-positive", () => {
    const a = makeAgent({ ...FARM_STAND });
    expect(a.storageCount("crop:parsnip")).toBe(0);
    a.addToStorage("crop:parsnip", 3);
    expect(a.storageCount("crop:parsnip")).toBe(3);
    a.addToStorage("crop:parsnip", 2); // merge into existing entry
    expect(a.storageCount("crop:parsnip")).toBe(5);
    a.addToStorage("crop:parsnip", 0); // no-op
    a.addToStorage("crop:potato", -1); // no-op
    expect(a.storageCount("crop:parsnip")).toBe(5);
    expect(a.storageCount("crop:potato")).toBe(0);
  });

  it("removeFromStorage: drains, drops empty entries, false + no-op when short", () => {
    const a = makeAgent({ ...FARM_STAND });
    a.addToStorage("crop:parsnip", 4);
    expect(a.removeFromStorage("crop:parsnip", 1)).toBe(true);
    expect(a.storageCount("crop:parsnip")).toBe(3);

    // Short / missing / non-positive → false, nothing removed.
    expect(a.removeFromStorage("crop:parsnip", 99)).toBe(false);
    expect(a.removeFromStorage("crop:potato", 1)).toBe(false);
    expect(a.removeFromStorage("crop:parsnip", 0)).toBe(false);
    expect(a.storageCount("crop:parsnip")).toBe(3);

    // Draining to zero removes the entry entirely.
    expect(a.removeFromStorage("crop:parsnip", 3)).toBe(true);
    expect(a.storageCount("crop:parsnip")).toBe(0);
    expect(a.homeStorage).toEqual([]);
  });
});

describe("DEPOSIT", () => {
  it("moves goods inventory → home storage on the bed; energy unchanged", async () => {
    const a = makeAgent({ ...BED_POS });
    a.addItem("crop:parsnip", 3);
    const energyBefore = a.energy;
    const r = await exec(a, act("DEPOSIT", { itemId: "crop:parsnip", qty: 2 }));
    expect(r.ok).toBe(true);
    expect(a.countItem("crop:parsnip")).toBe(1); // inventory decremented
    expect(a.storageCount("crop:parsnip")).toBe(2); // storage incremented
    expect(a.energy).toBe(energyBefore); // 0-cost logistics
  });

  it("rejects off the bed tile", async () => {
    const a = makeAgent({ ...FARM_STAND });
    a.addItem("crop:parsnip", 3);
    const r = await exec(a, act("DEPOSIT", { itemId: "crop:parsnip", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/on your bed/);
    expect(a.countItem("crop:parsnip")).toBe(3); // untouched
    expect(a.storageCount("crop:parsnip")).toBe(0);
  });

  it("rejects insufficient inventory qty without mutating either store", async () => {
    const a = makeAgent({ ...BED_POS });
    a.addItem("crop:parsnip", 1);
    const r = await exec(a, act("DEPOSIT", { itemId: "crop:parsnip", qty: 5 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/you have 1x crop:parsnip, not 5/);
    expect(a.countItem("crop:parsnip")).toBe(1);
    expect(a.storageCount("crop:parsnip")).toBe(0);
  });

  it("rejects a bad target", async () => {
    const a = makeAgent({ ...BED_POS });
    const r = await exec(a, act("DEPOSIT", { x: 1, y: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs an \{itemId, qty\} target/);
  });

  it("rejects hostile qty (NaN/Infinity/fractional/negative/zero) without corrupting stores", async () => {
    for (const qty of [Number.NaN, Infinity, -Infinity, -2, 0, 1.5]) {
      const a = makeAgent({ ...BED_POS });
      a.addItem("crop:parsnip", 3);
      const r = await exec(a, act("DEPOSIT", { itemId: "crop:parsnip", qty }));
      expect(r.ok, `qty=${qty}`).toBe(false);
      expect(a.countItem("crop:parsnip"), `qty=${qty}`).toBe(3);
      expect(a.storageCount("crop:parsnip"), `qty=${qty}`).toBe(0);
    }
  });
});

describe("WITHDRAW", () => {
  it("moves goods home storage → inventory on the bed", async () => {
    const a = makeAgent({ ...BED_POS });
    a.addToStorage("crop:potato", 3);
    const r = await exec(a, act("WITHDRAW", { itemId: "crop:potato", qty: 2 }));
    expect(r.ok).toBe(true);
    expect(a.storageCount("crop:potato")).toBe(1);
    expect(a.countItem("crop:potato")).toBe(2);
  });

  it("rejects off the bed tile", async () => {
    const a = makeAgent({ ...FARM_STAND });
    a.addToStorage("crop:potato", 3);
    const r = await exec(a, act("WITHDRAW", { itemId: "crop:potato", qty: 1 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/on your bed/);
    expect(a.storageCount("crop:potato")).toBe(3);
    expect(a.countItem("crop:potato")).toBe(0);
  });

  it("rejects insufficient stored qty without mutating either store", async () => {
    const a = makeAgent({ ...BED_POS });
    a.addToStorage("crop:potato", 1);
    const r = await exec(a, act("WITHDRAW", { itemId: "crop:potato", qty: 4 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/your storage has 1x crop:potato, not 4/);
    expect(a.storageCount("crop:potato")).toBe(1);
    expect(a.countItem("crop:potato")).toBe(0);
  });
});

describe("DEPOSIT + WITHDRAW round-trip conserves goods", () => {
  it("harvest-style add → DEPOSIT all → empty inventory → WITHDRAW → back exactly", async () => {
    const a = makeAgent({ ...BED_POS });
    a.addItem("crop:cauliflower", 5);
    expect(a.energy).toBe(ENERGY_START);

    // Stash the whole lot.
    const dep = await exec(a, act("DEPOSIT", { itemId: "crop:cauliflower", qty: 5 }));
    expect(dep.ok).toBe(true);
    expect(a.countItem("crop:cauliflower")).toBe(0); // inventory empty of crops
    expect(a.storageCount("crop:cauliflower")).toBe(5); // all in storage

    // Pull it back.
    const wit = await exec(a, act("WITHDRAW", { itemId: "crop:cauliflower", qty: 5 }));
    expect(wit.ok).toBe(true);
    expect(a.countItem("crop:cauliflower")).toBe(5); // qty out == qty in
    expect(a.storageCount("crop:cauliflower")).toBe(0); // storage drained

    // No duplication or loss anywhere; energy untouched.
    expect(a.energy).toBe(ENERGY_START);
  });
});
