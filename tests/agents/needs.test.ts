/**
 * NeedsSystem (Wave 3a) — intrinsic-drive layer.
 *
 * Covers: derive-on-read (energy/gold → drive), onOutcome refills (and the
 * failed-result no-refill guard), the onDayAdvanced regen pulse, dominant +
 * DRIVE_KEYS tie-break, full determinism (two runs deep-equal), and malformed
 * input never throwing. Pure-model: no Phaser, no LLM, $0.
 */
import { describe, expect, it } from "vitest";
import { ENERGY_START } from "@contracts/types";
import {
  clamp01,
  DRIVE_KEYS,
  DRIVE_URGENT,
  NEEDS_BASELINE,
  NeedsSystem,
  NOVELTY_DECAY_PER_PHASE,
  NOVELTY_REFILL,
  PURPOSE_REFILL,
  PURPOSE_REGEN_PER_DAY,
  SOCIAL_DECAY_PER_PHASE,
  SOCIAL_REFILL,
  WEALTH_COMFORT_GOLD,
} from "../../src/agents/Needs";

function agent(name: string, energy: number, gold: number) {
  return { name, energy, gold };
}

describe("clamp01", () => {
  it("clamps to [0,1] and collapses non-finite to 0", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
  });
});

describe("state() — lazy baseline + defensive copy", () => {
  it("returns the baseline for an unseen agent", () => {
    const ns = new NeedsSystem();
    expect(ns.state("Nobody")).toEqual(NEEDS_BASELINE);
  });

  it("returns a COPY — mutating the result never corrupts the live state", () => {
    const ns = new NeedsSystem();
    const s = ns.state("Alice");
    s.energy = 0.99;
    expect(ns.state("Alice").energy).toBe(NEEDS_BASELINE.energy);
    expect(ns.state("Alice")).not.toBe(ns.state("Alice"));
  });
});

describe("recomputeFromState — derive-on-read energy/wealth", () => {
  it("energy drive is high when exhausted, zero when full", () => {
    const ns = new NeedsSystem();
    ns.recomputeFromState(agent("A", ENERGY_START, 0));
    expect(ns.state("A").energy).toBe(0);
    ns.recomputeFromState(agent("A", 0, 0));
    expect(ns.state("A").energy).toBe(1);
    ns.recomputeFromState(agent("A", ENERGY_START / 2, 0));
    expect(ns.state("A").energy).toBeCloseTo(0.5, 5);
  });

  it("wealth drive is high when poor, zero at/above the comfort threshold", () => {
    const ns = new NeedsSystem();
    ns.recomputeFromState(agent("B", ENERGY_START, 0));
    expect(ns.state("B").wealth).toBe(1);
    ns.recomputeFromState(agent("B", ENERGY_START, WEALTH_COMFORT_GOLD));
    expect(ns.state("B").wealth).toBe(0);
    ns.recomputeFromState(agent("B", ENERGY_START, WEALTH_COMFORT_GOLD * 2));
    expect(ns.state("B").wealth).toBe(0); // clamped, never negative
    ns.recomputeFromState(agent("B", ENERGY_START, WEALTH_COMFORT_GOLD / 2));
    expect(ns.state("B").wealth).toBeCloseTo(0.5, 5);
  });

  it("does not touch social/novelty/purpose", () => {
    const ns = new NeedsSystem();
    const before = ns.state("C");
    ns.recomputeFromState(agent("C", 50, 100));
    const after = ns.state("C");
    expect(after.social).toBe(before.social);
    expect(after.novelty).toBe(before.novelty);
    expect(after.purpose).toBe(before.purpose);
  });
});

describe("onOutcome — refills only on success", () => {
  it("TALK_TO success drops the social drive by SOCIAL_REFILL", () => {
    const ns = new NeedsSystem();
    const baseSocial = ns.state("A").social;
    ns.onOutcome(agent("A", 100, 0), { action: "TALK_TO" } as never, { ok: true });
    expect(ns.state("A").social).toBeCloseTo(clamp01(baseSocial - SOCIAL_REFILL), 5);
  });

  it("GIVE_GIFT success also satisfies the social drive", () => {
    const ns = new NeedsSystem();
    const baseSocial = ns.state("A").social;
    ns.onOutcome(agent("A", 100, 0), { action: "GIVE_GIFT" } as never, { ok: true });
    expect(ns.state("A").social).toBeCloseTo(clamp01(baseSocial - SOCIAL_REFILL), 5);
  });

  it("HARVEST/SELL success drops the purpose drive by PURPOSE_REFILL", () => {
    const ns = new NeedsSystem();
    const basePurpose = ns.state("A").purpose;
    ns.onOutcome(agent("A", 100, 0), { action: "HARVEST" } as never, { ok: true });
    expect(ns.state("A").purpose).toBeCloseTo(clamp01(basePurpose - PURPOSE_REFILL), 5);
  });

  it("novelty drops on a NEW action kind and rises on a repeated one", () => {
    const ns = new NeedsSystem();
    const base = ns.state("A").novelty;
    // first action: kind differs from (no) previous → novelty refilled (drops)
    ns.onOutcome(agent("A", 100, 0), { action: "TILL" } as never, { ok: true });
    const afterFirst = ns.state("A").novelty;
    expect(afterFirst).toBeCloseTo(clamp01(base - NOVELTY_REFILL), 5);
    // same kind repeated → novelty rises (boredom)
    ns.onOutcome(agent("A", 100, 0), { action: "TILL" } as never, { ok: true });
    expect(ns.state("A").novelty).toBeCloseTo(
      clamp01(afterFirst + NOVELTY_DECAY_PER_PHASE),
      5,
    );
  });

  it("failed results NEVER refill", () => {
    const ns = new NeedsSystem();
    const before = ns.state("A");
    ns.onOutcome(agent("A", 100, 0), { action: "TALK_TO" } as never, { ok: false });
    ns.onOutcome(agent("A", 100, 0), { action: "HARVEST" } as never, { ok: false });
    expect(ns.state("A")).toEqual(before);
  });
});

describe("onDayAdvanced — morning regen pulse", () => {
  it("raises social/novelty by per-phase×4 and purpose by the daily regen", () => {
    const ns = new NeedsSystem();
    const base = ns.state("A");
    ns.onDayAdvanced("A");
    const after = ns.state("A");
    expect(after.social).toBeCloseTo(clamp01(base.social + SOCIAL_DECAY_PER_PHASE * 4), 5);
    expect(after.novelty).toBeCloseTo(clamp01(base.novelty + NOVELTY_DECAY_PER_PHASE * 4), 5);
    expect(after.purpose).toBeCloseTo(clamp01(base.purpose + PURPOSE_REGEN_PER_DAY), 5);
  });

  it("keeps every drive inside [0,1] after repeated pulses", () => {
    const ns = new NeedsSystem();
    for (let i = 0; i < 20; i++) ns.onDayAdvanced("A");
    const s = ns.state("A");
    for (const k of DRIVE_KEYS) {
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(1);
    }
  });
});

describe("dominant — argmax with DRIVE_KEYS tie-break", () => {
  it("returns the single most-pressing drive", () => {
    const ns = new NeedsSystem();
    ns.recomputeFromState(agent("A", 0, 0)); // energy=1, wealth=1, others baseline
    // energy & wealth both 1 → tie broken toward energy (earlier in DRIVE_KEYS)
    expect(ns.dominant("A")).toBe("energy");
  });

  it("ties break in DRIVE_KEYS order", () => {
    const ns = new NeedsSystem();
    // baseline: energy 0, wealth 0.5, social 0.3, novelty 0.3, purpose 0.5
    // wealth & purpose tie at 0.5 → wealth wins (earlier key)
    expect(ns.dominant("A")).toBe("wealth");
    expect(DRIVE_KEYS.indexOf("wealth")).toBeLessThan(DRIVE_KEYS.indexOf("purpose"));
  });

  it("an unseen agent reports the baseline dominant deterministically", () => {
    const ns = new NeedsSystem();
    expect(ns.dominant("Ghost")).toBe("wealth");
  });
});

describe("determinism", () => {
  it("two identical event sequences yield deep-equal state", () => {
    const run = () => {
      const ns = new NeedsSystem();
      ns.recomputeFromState(agent("A", 30, 120));
      ns.onOutcome(agent("A", 30, 120), { action: "TILL" } as never, { ok: true });
      ns.onOutcome(agent("A", 30, 120), { action: "TALK_TO" } as never, { ok: true });
      ns.onDayAdvanced("A");
      ns.onOutcome(agent("A", 30, 120), { action: "HARVEST" } as never, { ok: true });
      return ns.state("A");
    };
    expect(run()).toEqual(run());
  });
});

describe("malformed input — never throws", () => {
  it("tolerates null/garbage agents, actions, and results", () => {
    const ns = new NeedsSystem();
    expect(() => {
      ns.recomputeFromState(null);
      ns.recomputeFromState(undefined);
      ns.recomputeFromState({} as never);
      ns.recomputeFromState({ name: "X" } as never); // missing energy/gold
      ns.onOutcome(null, null, null);
      ns.onOutcome({ name: "X" }, {} as never, { ok: true });
      ns.onOutcome({ name: "X" }, { action: 42 } as never, { ok: true });
      ns.onDayAdvanced(undefined as never);
      ns.dominant(undefined as never);
      ns.state(undefined as never);
    }).not.toThrow();
  });

  it("DRIVE_URGENT is the pinned 0.75 threshold", () => {
    expect(DRIVE_URGENT).toBe(0.75);
  });
});
