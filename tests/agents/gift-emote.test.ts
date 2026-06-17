/**
 * §4.4 v2 rows — GIVE_GIFT full precondition matrix (shape, receiver
 * existence, 4-adjacency, qty gate, ownership) + exactly-1 transfer +
 * both-sides cognition hook, and EMOTE (always legal, render-only).
 * Plus the availableActions additions (EMOTE energy gate, GIVE_GIFT
 * adjacency+item gate).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAction, Emotion, RenderApi, Vec2 } from "@contracts/types";
import { getWorld, resetWorldForTests } from "../../src/world/instance";
import { setRenderApi } from "../../src/world/render";
import { Agent } from "../../src/agents/Agent";
import { computeAvailableActions } from "../../src/agents/Observation";
import {
  executeAction,
  type ExecutorCognitionHooks,
} from "../../src/agents/ActionExecutor";

function makeAgent(pos: Vec2, name = "Giver"): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: "a test farmer",
    color: 0xffffff,
    start: pos,
  });
}

function gift(agentName: string, itemId = "seed:parsnip", qty: number = 1): AgentAction {
  return {
    thought: "t",
    say: null,
    action: "GIVE_GIFT",
    target: { agentName, itemId, qty },
  };
}

interface HookLog {
  gifts: { giver: string; receiver: string; itemId: string }[];
  talks: { speaker: string; listener: string; say: string | null }[];
}

function makeHooks(): { hooks: ExecutorCognitionHooks; log: HookLog } {
  const log: HookLog = { gifts: [], talks: [] };
  return {
    hooks: {
      onGift: (giver, receiver, itemId) =>
        log.gifts.push({ giver: giver.name, receiver: receiver.name, itemId }),
      onTalk: (speaker, listener, say) =>
        log.talks.push({ speaker: speaker.name, listener: listener.name, say }),
    },
    log,
  };
}

beforeEach(() => {
  resetWorldForTests();
});

afterEach(() => {
  setRenderApi(null);
});

describe("GIVE_GIFT precondition matrix", () => {
  it("rejects malformed targets (missing fields / wrong shape / no target)", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 9, y: 10 }, "Receiver");
    const bad: AgentAction["target"][] = [
      undefined,
      { x: 9, y: 10 },
      { agentName: "Receiver" },
      { agentName: "Receiver", itemId: "seed:parsnip" } as never,
      { itemId: "seed:parsnip", qty: 1 },
    ];
    for (const target of bad) {
      const action: AgentAction = { thought: "t", say: null, action: "GIVE_GIFT" };
      if (target !== undefined) action.target = target;
      const r = await executeAction(a, action, getWorld(), [b]);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("GIVE_GIFT needs");
    }
  });

  it("rejects unknown receivers and self-gifting", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 9, y: 10 }, "Receiver");
    const ghost = await executeAction(a, gift("Casper"), getWorld(), [b]);
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toContain("no agent named");
    const selfish = await executeAction(a, gift("Giver"), getWorld(), [a, b]);
    expect(selfish.ok).toBe(false);
  });

  it("rejects non-4-adjacent receivers (diagonal and distant)", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const diagonal = makeAgent({ x: 10, y: 10 }, "Receiver"); // Chebyshev 1, NOT 4-adjacent
    const r1 = await executeAction(a, gift("Receiver"), getWorld(), [diagonal]);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain("too far away");
    const far = makeAgent({ x: 13, y: 9 }, "Receiver");
    const r2 = await executeAction(a, gift("Receiver"), getWorld(), [far]);
    expect(r2.ok).toBe(false);
  });

  it("gates qty hard: NaN/Infinity/0/-1/1.5 all reject without mutating anything", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 9, y: 10 }, "Receiver");
    // non-finite qty fails the target-shape gate (like BUY/SELL's isItemTarget)
    for (const qty of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await executeAction(a, gift("Receiver", "seed:parsnip", qty), getWorld(), [b]);
      expect(r.ok, `qty ${qty}`).toBe(false);
      expect(r.reason).toContain("GIVE_GIFT needs");
    }
    // finite-but-hostile qty fails the gateQty hardening
    for (const qty of [0, -1, 1.5]) {
      const r = await executeAction(a, gift("Receiver", "seed:parsnip", qty), getWorld(), [b]);
      expect(r.ok, `qty ${qty}`).toBe(false);
      expect(r.reason).toContain("whole number");
    }
    expect(a.countItem("seed:parsnip")).toBe(5); // untouched
    expect(b.countItem("seed:parsnip")).toBe(5);
  });

  it("rejects gifting an item the giver does not hold (qty >= 1 rule)", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 9, y: 10 }, "Receiver");
    const r = await executeAction(a, gift("Receiver", "crop:parsnip"), getWorld(), [b]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("crop:parsnip");
  });

  it("transfers EXACTLY 1 (even when qty asks for more) and fires onGift", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 8, y: 9 }, "Receiver");
    const { hooks, log } = makeHooks();
    const r = await executeAction(
      a,
      gift("Receiver", "seed:parsnip", 3),
      getWorld(),
      [b],
      { cognition: hooks },
    );
    expect(r).toEqual({ ok: true });
    expect(a.countItem("seed:parsnip")).toBe(4); // 5 - exactly 1
    expect(b.countItem("seed:parsnip")).toBe(6);
    expect(log.gifts).toEqual([
      { giver: "Giver", receiver: "Receiver", itemId: "seed:parsnip" },
    ]);
  });

  it("removes the inventory entry when the last item is given; energy untouched", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    a.inventory = [{ itemId: "crop:potato", qty: 1 }];
    a.energy = 0; // GIVE_GIFT costs 0 — §4.4 has no energy row for it
    const b = makeAgent({ x: 9, y: 8 }, "Receiver");
    const r = await executeAction(a, gift("Receiver", "crop:potato"), getWorld(), [b]);
    expect(r.ok).toBe(true);
    expect(a.inventory).toEqual([]);
    expect(b.countItem("crop:potato")).toBe(1);
    expect(a.energy).toBe(0);
  });
});

describe("EMOTE", () => {
  it("is always legal — ok even at 0 energy, with no world mutation", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    a.energy = 0;
    const before = getWorld().getTile(9, 9)?.type;
    const r = await executeAction(
      a,
      { thought: "t", say: null, action: "EMOTE", emotion: "sad" },
      getWorld(),
      [],
    );
    expect(r).toEqual({ ok: true });
    expect(getWorld().getTile(9, 9)?.type).toBe(before);
    expect(a.energy).toBe(0);
    expect(a.gold).toBe(200);
  });

  it("plays the emote via RenderApi with emotion ?? neutral (null-safe without a scene)", async () => {
    const played: { name: string; emotion: Emotion }[] = [];
    const stub: RenderApi = {
      registerAgentSprite: () => {},
      setAgentPos: () => {},
      showSpeech: () => {},
      playEmote: (name, emotion) => played.push({ name, emotion }),
    };
    setRenderApi(stub);
    const a = makeAgent({ x: 9, y: 9 });
    await executeAction(
      a,
      { thought: "t", say: null, action: "EMOTE", emotion: "excited" },
      getWorld(),
      [],
    );
    await executeAction(a, { thought: "t", say: null, action: "EMOTE" }, getWorld(), []);
    expect(played).toEqual([
      { name: "Giver", emotion: "excited" },
      { name: "Giver", emotion: "neutral" },
    ]);

    setRenderApi(null); // headless: must not throw
    const r = await executeAction(
      a,
      { thought: "t", say: null, action: "EMOTE", emotion: "happy" },
      getWorld(),
      [],
    );
    expect(r.ok).toBe(true);
  });
});

describe("TALK_TO cognition hook (v2)", () => {
  it("fires onTalk with the spoken line (or null) when the talk resolves", async () => {
    const a = makeAgent({ x: 9, y: 9 });
    const b = makeAgent({ x: 9, y: 10 }, "Receiver");
    const { hooks, log } = makeHooks();
    await executeAction(
      a,
      { thought: "t", say: "Nice crops!", action: "TALK_TO", target: { agentName: "Receiver" } },
      getWorld(),
      [b],
      { cognition: hooks },
    );
    await executeAction(
      a,
      { thought: "t", say: null, action: "TALK_TO", target: { agentName: "Receiver" } },
      getWorld(),
      [b],
      { cognition: hooks },
    );
    expect(log.talks).toEqual([
      { speaker: "Giver", listener: "Receiver", say: "Nice crops!" },
      { speaker: "Giver", listener: "Receiver", say: null },
    ]);
  });
});

describe("availableActions v2 additions", () => {
  it("offers EMOTE only above the rule-3 energy floor", () => {
    const a = makeAgent({ x: 9, y: 9 });
    expect(computeAvailableActions(a, getWorld(), [])).toContain("EMOTE");
    a.energy = 0;
    expect(computeAvailableActions(a, getWorld(), [])).not.toContain("EMOTE");
  });

  it("offers GIVE_GIFT only with a 4-adjacent other agent AND a held item", () => {
    const a = makeAgent({ x: 9, y: 9 });
    const adjacent = makeAgent({ x: 9, y: 10 }, "B");
    const diagonal = makeAgent({ x: 10, y: 10 }, "C");
    expect(computeAvailableActions(a, getWorld(), [adjacent])).toContain("GIVE_GIFT");
    // diagonal neighbors can TALK_TO (Chebyshev) but not GIVE_GIFT (4-adjacent)
    const diagActs = computeAvailableActions(a, getWorld(), [diagonal]);
    expect(diagActs).toContain("TALK_TO");
    expect(diagActs).not.toContain("GIVE_GIFT");
    // nothing to give -> not offered
    a.inventory = [];
    expect(computeAvailableActions(a, getWorld(), [adjacent])).not.toContain("GIVE_GIFT");
    // energy floor hides it too
    a.inventory = [{ itemId: "seed:parsnip", qty: 1 }];
    a.energy = 0;
    expect(computeAvailableActions(a, getWorld(), [adjacent])).not.toContain("GIVE_GIFT");
  });
});
