/**
 * Kill-switch badge state machine (contract rule 13 — the demo's thesis).
 * live → offline on "llm_offline", back on "llm_recovered"; mock mode is a
 * terminal latch; labels/styles are distinct and high-contrast per state.
 */
import { describe, expect, it } from "vitest";
import {
  KILL_SWITCH_LABELS,
  KILL_SWITCH_STYLES,
  KillSwitchModel,
  killSwitchLabel,
  killSwitchStyle,
} from "../../src/obs/KillSwitch";

describe("KillSwitchModel", () => {
  it("starts LIVE only when VITE_MODEL_MODE is exactly 'live'", () => {
    expect(new KillSwitchModel("live").state()).toBe("live");
    expect(new KillSwitchModel("mock").state()).toBe("mock");
    expect(new KillSwitchModel(undefined).state()).toBe("mock");
    expect(new KillSwitchModel("LIVE").state()).toBe("mock"); // exact match
  });

  it("live → offline on llm_offline, → live again on llm_recovered", () => {
    const m = new KillSwitchModel("live");
    expect(m.apply("llm_offline")).toBe(true);
    expect(m.state()).toBe("offline");
    expect(m.apply("llm_recovered")).toBe(true);
    expect(m.state()).toBe("live");
  });

  it("repeated transitions only report a change once", () => {
    const m = new KillSwitchModel("live");
    expect(m.apply("llm_offline")).toBe(true);
    expect(m.apply("llm_offline")).toBe(false); // already offline
    expect(m.apply("llm_recovered")).toBe(true);
    expect(m.apply("llm_recovered")).toBe(false); // already live
  });

  it("llm_recovered without a preceding offline is a no-op", () => {
    const m = new KillSwitchModel("live");
    expect(m.apply("llm_recovered")).toBe(false);
    expect(m.state()).toBe("live");
  });

  it("mock mode is terminal — offline/recovered events never flip it", () => {
    const m = new KillSwitchModel(undefined);
    expect(m.apply("llm_offline")).toBe(false);
    expect(m.apply("llm_recovered")).toBe(false);
    expect(m.state()).toBe("mock");
  });

  it("unrelated event kinds never change the state", () => {
    const m = new KillSwitchModel("live");
    for (const kind of ["turn_start", "agent_speech", "budget_reached", "mystery_kind"]) {
      expect(m.apply(kind)).toBe(false);
    }
    expect(m.state()).toBe("live");
  });
});

describe("badge labels + styles", () => {
  it("spells out the canned-behavior states (rule 13 wording)", () => {
    expect(killSwitchLabel("offline")).toContain("LLM OFFLINE");
    expect(killSwitchLabel("offline")).toContain("canned behavior");
    expect(killSwitchLabel("mock")).toContain("MOCK MODE");
    expect(killSwitchLabel("mock")).toContain("canned behavior");
    expect(killSwitchLabel("live")).toContain("LIVE");
  });

  it("labels and background styles are pairwise distinct", () => {
    const labels = Object.values(KILL_SWITCH_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    const bgs = Object.values(KILL_SWITCH_STYLES).map((s) => s.bg);
    expect(new Set(bgs).size).toBe(bgs.length);
    for (const state of ["live", "offline", "mock"] as const) {
      const { fg, bg } = killSwitchStyle(state);
      expect(fg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(fg).not.toBe(bg);
    }
  });
});
