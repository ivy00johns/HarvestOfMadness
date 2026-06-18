/**
 * RolesSystem (Wave 4a) — emergent role specialization (pure model + the
 * mock-decision role bias).
 *
 * Covers: vocabulary + ACTION_ROLE_BUCKET map; derivation per bucket
 * (sell→merchant, harvest→farmer, talk→socialite, move→wanderer); the banker
 * gold overlay; the MIN_SAMPLE floor; full determinism (two runs deep-equal);
 * hysteresis / no-thrash (off-role noise doesn't flip, sustained margin does);
 * failed results ignored; rolling FIFO eviction past ROLE_WINDOW; malformed
 * input never throws; and that a non-default role actually steers the mock
 * decision (merchant → MOVE_TO shop, socialite with no adjacent neighbor → NO
 * convergence move, farmer → plain WAIT, same-obs-twice byte-identical).
 * Pure-model: no Phaser, no LLM, $0.
 */
import { describe, expect, it } from "vitest";
import type { LlmRequest, Observation } from "@contracts/types";
import { ROLE_VOCABULARY } from "@contracts/types";
import {
  ACTION_ROLE_BUCKET,
  BANKER_GOLD_THRESHOLD,
  DEFAULT_ROLE,
  ROLE_HYSTERESIS_MARGIN,
  ROLE_MIN_SAMPLE,
  ROLE_PRIORITY,
  ROLE_WINDOW,
  RolesSystem,
} from "../../src/agents/Roles";
import { mockRouter } from "../../src/llm/mock";
import { buildUserPrompt, buildSystemPrompt } from "../../src/llm/prompts";

function agent(name: string, gold = 0) {
  return { name, gold };
}

/** Feed n successful actions of one kind to an agent. */
function feed(rs: RolesSystem, name: string, kind: string, n: number, gold = 0): void {
  for (let i = 0; i < n; i++) {
    rs.onOutcome(agent(name, gold), { action: kind } as never, { ok: true });
  }
}

describe("vocabulary + bucket map", () => {
  it("ROLE_VOCABULARY is the pinned 5-role list, farmer first", () => {
    expect([...ROLE_VOCABULARY]).toEqual([
      "farmer",
      "merchant",
      "socialite",
      "wanderer",
      "banker",
    ]);
    expect(DEFAULT_ROLE).toBe("farmer");
  });

  it("ACTION_ROLE_BUCKET maps the role-bearing actions and OMITS idle/flavor ones", () => {
    expect(ACTION_ROLE_BUCKET.TILL).toBe("farmer");
    expect(ACTION_ROLE_BUCKET.PLANT).toBe("farmer");
    expect(ACTION_ROLE_BUCKET.WATER).toBe("farmer");
    expect(ACTION_ROLE_BUCKET.HARVEST).toBe("farmer");
    expect(ACTION_ROLE_BUCKET.BUY).toBe("merchant");
    expect(ACTION_ROLE_BUCKET.SELL).toBe("merchant");
    expect(ACTION_ROLE_BUCKET.TALK_TO).toBe("socialite");
    expect(ACTION_ROLE_BUCKET.GIVE_GIFT).toBe("socialite");
    expect(ACTION_ROLE_BUCKET.MOVE_TO).toBe("wanderer");
    expect(ACTION_ROLE_BUCKET.USE_OBJECT).toBe("wanderer");
    // idle / flavor actions carry no role signal
    expect(ACTION_ROLE_BUCKET.WAIT).toBeUndefined();
    expect(ACTION_ROLE_BUCKET.EMOTE).toBeUndefined();
    expect(ACTION_ROLE_BUCKET.SLEEP).toBeUndefined();
  });

  it("ROLE_PRIORITY is farmer-first and excludes the banker overlay", () => {
    expect([...ROLE_PRIORITY]).toEqual(["farmer", "merchant", "socialite", "wanderer"]);
    expect(ROLE_PRIORITY).not.toContain("banker");
  });
});

describe("derivation per bucket (argmax over the window)", () => {
  it("sell-heavy → merchant", () => {
    const rs = new RolesSystem();
    feed(rs, "M", "SELL", 10);
    expect(rs.derive("M", 0)).toBe("merchant");
  });

  it("harvest-heavy → farmer", () => {
    const rs = new RolesSystem();
    feed(rs, "F", "HARVEST", 10);
    expect(rs.derive("F", 0)).toBe("farmer");
  });

  it("talk-heavy → socialite", () => {
    const rs = new RolesSystem();
    feed(rs, "S", "TALK_TO", 10);
    expect(rs.derive("S", 0)).toBe("socialite");
  });

  it("move-heavy → wanderer", () => {
    const rs = new RolesSystem();
    feed(rs, "W", "MOVE_TO", 10);
    expect(rs.derive("W", 0)).toBe("wanderer");
  });

  it("ties break toward farmer (ROLE_PRIORITY)", () => {
    const rs = new RolesSystem();
    // 5 farmer + 5 socialite — equal counts; farmer wins on priority.
    feed(rs, "T", "TILL", 5);
    feed(rs, "T", "TALK_TO", 5);
    expect(rs.derive("T", 0)).toBe("farmer");
  });
});

describe("banker overlay (gold gate)", () => {
  it("merchant-leaning + gold ≥ threshold → banker", () => {
    const rs = new RolesSystem();
    feed(rs, "B", "SELL", 10);
    expect(rs.derive("B", BANKER_GOLD_THRESHOLD)).toBe("banker");
    expect(rs.derive("B", BANKER_GOLD_THRESHOLD + 1000)).toBe("banker");
  });

  it("merchant-leaning but POOR → merchant (no overlay below the gold gate)", () => {
    const rs = new RolesSystem();
    feed(rs, "B", "SELL", 10);
    expect(rs.derive("B", BANKER_GOLD_THRESHOLD - 1)).toBe("merchant");
  });

  it("wealthy but NOT merchant-leaning → no banker overlay (stays farmer)", () => {
    const rs = new RolesSystem();
    feed(rs, "B", "HARVEST", 10); // pure farmer, zero merchant signal
    expect(rs.derive("B", BANKER_GOLD_THRESHOLD + 5000)).toBe("farmer");
  });
});

describe("MIN_SAMPLE floor", () => {
  it("below ROLE_MIN_SAMPLE bucketed actions → farmer regardless of bias", () => {
    const rs = new RolesSystem();
    feed(rs, "U", "SELL", ROLE_MIN_SAMPLE - 1); // one short
    expect(rs.derive("U", 0)).toBe("farmer");
    // crossing the floor flips to the real bias
    feed(rs, "U", "SELL", 1);
    expect(rs.derive("U", 0)).toBe("merchant");
  });

  it("an unknown agent derives to farmer", () => {
    const rs = new RolesSystem();
    expect(rs.derive("Ghost", 9999)).toBe("farmer");
    expect(rs.role("Ghost")).toBe("farmer");
  });
});

describe("determinism", () => {
  it("two identical event sequences yield the same derived + current role", () => {
    const run = () => {
      const rs = new RolesSystem();
      feed(rs, "A", "SELL", 6);
      feed(rs, "A", "TILL", 3);
      feed(rs, "A", "TALK_TO", 2);
      const derived = rs.derive("A", 500);
      const current = rs.update(agent("A", 500));
      return { derived, current };
    };
    expect(run()).toEqual(run());
  });
});

describe("hysteresis / no thrash (only sustained margin flips)", () => {
  it("a few off-role actions do NOT flip the current role", () => {
    const rs = new RolesSystem();
    // Establish a clear farmer label.
    feed(rs, "H", "HARVEST", 16);
    expect(rs.update(agent("H", 0))).toBe("farmer");

    // Inject a little merchant noise (well under the hysteresis margin).
    feed(rs, "H", "SELL", 2);
    expect(rs.update(agent("H", 0))).toBe("farmer"); // sticks
  });

  it("sustained off-role behavior past the margin DOES flip", () => {
    const rs = new RolesSystem();
    feed(rs, "H", "HARVEST", 16);
    expect(rs.update(agent("H", 0))).toBe("farmer");

    // Flood with selling — the window rolls until merchant dominates by margin.
    feed(rs, "H", "SELL", ROLE_WINDOW);
    expect(rs.update(agent("H", 0))).toBe("merchant");
  });

  it("the hysteresis margin is the pinned 0.15 share", () => {
    expect(ROLE_HYSTERESIS_MARGIN).toBeCloseTo(0.15, 5);
  });
});

describe("failed results are ignored", () => {
  it("only successful, role-bearing actions histogram", () => {
    const rs = new RolesSystem();
    // 10 FAILED sells must not make a merchant.
    for (let i = 0; i < 10; i++) {
      rs.onOutcome(agent("X", 0), { action: "SELL" } as never, { ok: false });
    }
    expect(rs.derive("X", 0)).toBe("farmer"); // empty window → MIN_SAMPLE floor
    // WAIT/EMOTE/SLEEP successes also carry no signal.
    feed(rs, "X", "WAIT", 10);
    feed(rs, "X", "EMOTE", 10);
    expect(rs.derive("X", 0)).toBe("farmer");
  });
});

describe("rolling FIFO eviction past ROLE_WINDOW", () => {
  it("only the most recent ROLE_WINDOW actions count", () => {
    const rs = new RolesSystem();
    // Fill the window with farming, then overwrite it entirely with selling.
    feed(rs, "R", "HARVEST", ROLE_WINDOW);
    feed(rs, "R", "SELL", ROLE_WINDOW); // evicts every HARVEST
    expect(rs.derive("R", 0)).toBe("merchant");
  });
});

describe("malformed input — never throws", () => {
  it("tolerates null/garbage agents, actions, and results", () => {
    const rs = new RolesSystem();
    expect(() => {
      rs.onOutcome(null, null, null);
      rs.onOutcome(undefined, undefined, undefined);
      rs.onOutcome({} as never, {} as never, { ok: true });
      rs.onOutcome({ name: "X" }, { action: 42 } as never, { ok: true });
      rs.onOutcome({ name: "X" }, { action: "SELL" } as never, null);
      rs.derive(null, NaN);
      rs.derive(undefined, 0);
      rs.update(null);
      rs.update({} as never);
      rs.role(null);
      rs.role(undefined as never);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Role influences the mock decision (deterministic, non-convergent).
// ---------------------------------------------------------------------------

/**
 * A "nothing pressing" observation: holding crops, the shop visible but NOT
 * adjacent, no tillable/waterable/plantable work in sight, so the farm ladder
 * bottoms out and the FINAL role-bias slot is reached. Role is parameterized.
 */
function idleObs(role: string): Observation {
  return {
    self: {
      name: "Roley",
      persona: "A plain farmer",
      role,
      pos: { x: 9, y: 9 },
      energy: 80,
      gold: 100,
      // Holds seeds too, so the "out of seeds → go buy" ladder step (7) is
      // skipped and the scene is genuinely "nothing pressing" for a farmer.
      inventory: [
        { itemId: "crop:parsnip", qty: 3 },
        { itemId: "seed:parsnip", qty: 2 },
      ],
      goal: null,
    },
    time: { day: 1, phase: "afternoon" },
    nearby: {
      // Only a building tile under the agent — nothing tillable/waterable.
      tiles: [{ x: 9, y: 9, type: "building" }],
      agents: [],
      landmarks: [
        { kind: "bed", pos: { x: 3, y: 4 } },
        { kind: "shop", pos: { x: 19, y: 4 } }, // far → not adjacent
      ],
    },
    lastAction: null,
    availableActions: ["MOVE_TO", "TALK_TO", "WAIT"],
    economy: { sells: {}, buys: {} },
  };
}

function reqFor(obs: Observation): LlmRequest {
  return {
    agentId: obs.self.name,
    system: buildSystemPrompt(obs.self.persona),
    user: buildUserPrompt(obs),
  };
}

describe("role steers the mock decision (dispersive / shop-only)", () => {
  it("merchant holding crops + shop visible → MOVE_TO the shop (economic, not the tavern)", async () => {
    const res = await mockRouter(reqFor(idleObs("merchant")));
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual({ x: 19, y: 4 }); // the shop, not the tavern
  });

  it("banker behaves like merchant (heads to the shop with goods)", async () => {
    const res = await mockRouter(reqFor(idleObs("banker")));
    expect(res.parsed?.action).toBe("MOVE_TO");
    expect(res.parsed?.target).toEqual({ x: 19, y: 4 });
  });

  it("farmer (default role) gets NO bias → plain WAIT", async () => {
    const res = await mockRouter(reqFor(idleObs("farmer")));
    expect(res.parsed?.action).toBe("WAIT");
  });

  it("socialite with NO adjacent neighbor → NO convergence move (falls through to WAIT)", async () => {
    // idleObs has zero nearby agents → the socialite chat nudge cannot fire and
    // nothing pulls the agent anywhere.
    const res = await mockRouter(reqFor(idleObs("socialite")));
    expect(res.parsed?.action).toBe("WAIT");
  });

  it("same role-biased observation twice → byte-identical decision", async () => {
    const req = reqFor(idleObs("merchant"));
    const a = await mockRouter(req);
    const b = await mockRouter(req);
    expect(b.raw).toBe(a.raw);
    expect(b.parsed).toEqual(a.parsed);
  });

  it("the role section only appears in the prompt for a non-default role", () => {
    expect(buildUserPrompt(idleObs("farmer"))).not.toContain("EMERGENT ROLE");
    expect(buildUserPrompt(idleObs("merchant"))).toContain("the town sees you as a merchant");
  });
});
