import { describe, expect, it } from "vitest";
import { TimeSystem } from "../../src/world/TimeSystem";

const PHASE = 1000; // short phase duration for tests

describe("TimeSystem", () => {
  it("starts at day 1, morning", () => {
    const ts = new TimeSystem(PHASE);
    expect(ts.state()).toEqual({ day: 1, phase: "morning" });
  });

  it("auto-advances phases on accumulated real time", () => {
    const ts = new TimeSystem(PHASE);
    ts.tick(999);
    expect(ts.state().phase).toBe("morning");
    ts.tick(1);
    expect(ts.state().phase).toBe("afternoon");
    ts.tick(PHASE);
    expect(ts.state().phase).toBe("evening");
    ts.tick(PHASE);
    expect(ts.state().phase).toBe("night");
  });

  it("night never auto-rolls to morning, no matter how much time passes", () => {
    const ts = new TimeSystem(PHASE);
    ts.tick(PHASE * 100);
    expect(ts.state()).toEqual({ day: 1, phase: "night" });
    ts.tick(PHASE * 100);
    expect(ts.state()).toEqual({ day: 1, phase: "night" });
  });

  it("speed multiplier scales phase progression (4x and 0.5x)", () => {
    const fast = new TimeSystem(PHASE);
    fast.setSpeed(4);
    fast.tick(PHASE / 4);
    expect(fast.state().phase).toBe("afternoon");

    const slow = new TimeSystem(PHASE);
    slow.setSpeed(0.5);
    slow.tick(PHASE);
    expect(slow.state().phase).toBe("morning");
    slow.tick(PHASE);
    expect(slow.state().phase).toBe("afternoon");
  });

  it("pause stops phase progression; resume continues", () => {
    const ts = new TimeSystem(PHASE);
    ts.pause();
    expect(ts.isPaused()).toBe(true);
    ts.tick(PHASE * 10);
    expect(ts.state().phase).toBe("morning");
    ts.resume();
    ts.tick(PHASE);
    expect(ts.state().phase).toBe("afternoon");
  });

  it("step advances exactly one phase and is a no-op at night", () => {
    const ts = new TimeSystem(PHASE);
    ts.step();
    expect(ts.state().phase).toBe("afternoon");
    ts.step();
    ts.step();
    expect(ts.state().phase).toBe("night");
    ts.step(); // night: no-op, sleep owns the day roll
    expect(ts.state()).toEqual({ day: 1, phase: "night" });
  });

  it("only advanceDay (SLEEP) rolls the day, back to morning", () => {
    const ts = new TimeSystem(PHASE);
    ts.tick(PHASE * 3);
    expect(ts.state()).toEqual({ day: 1, phase: "night" });
    ts.advanceDay();
    expect(ts.state()).toEqual({ day: 2, phase: "morning" });
  });

  it("notifies subscribers on change and supports unsubscribe", () => {
    const ts = new TimeSystem(PHASE);
    const seen: string[] = [];
    const off = ts.onChange((t) => seen.push(`${t.day}:${t.phase}`));
    ts.step();
    ts.advanceDay();
    expect(seen).toEqual(["1:afternoon", "2:morning"]);
    off();
    ts.step();
    expect(seen).toHaveLength(2);
  });
});
