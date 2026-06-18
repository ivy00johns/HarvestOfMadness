/**
 * DiaryPanel — pure builder for the agent diary view.
 *
 * buildDiaryPanel(entries, agentName, maxLines=5) → DiaryPanelView:
 *   - lines are NEWEST-FIRST (entries arrive oldest-first) and capped
 *   - latestText is the single newest entry's text
 *   - defensive against garbage entries and zero/empty input; never throws
 */
import { describe, expect, it } from "vitest";
import type { DiaryEntry } from "@contracts/types";
import { buildDiaryPanel } from "../../src/obs/DiaryPanel";

function entry(day: number, text: string, phase = "morning"): DiaryEntry {
  return { day, phase, text };
}

describe("buildDiaryPanel", () => {
  it("renders entries newest-first with render-ready labels", () => {
    const view = buildDiaryPanel(
      [entry(1, "First day on the farm."), entry(2, "Sold my first parsnips.")],
      "Dora",
    );
    expect(view.agentName).toBe("Dora");
    expect(view.lines.map((l) => l.day)).toEqual([2, 1]); // newest-first
    expect(view.lines[0].label).toBe("Day 2 (morning): Sold my first parsnips.");
    expect(view.latestText).toBe("Sold my first parsnips.");
    expect(view.count).toBe(2);
  });

  it("caps the lines to maxLines (default 5) keeping the newest", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(i + 1, `entry ${i + 1}`));
    const view = buildDiaryPanel(entries, "Dora");
    expect(view.lines).toHaveLength(5);
    expect(view.lines.map((l) => l.day)).toEqual([8, 7, 6, 5, 4]);
    expect(view.count).toBe(8); // count reflects all available, before the cap
  });

  it("respects an explicit maxLines argument", () => {
    const entries = [entry(1, "a"), entry(2, "b"), entry(3, "c")];
    const view = buildDiaryPanel(entries, "Dora", 2);
    expect(view.lines.map((l) => l.day)).toEqual([3, 2]);
  });

  it("handles an empty list without throwing", () => {
    const view = buildDiaryPanel([], "Dora");
    expect(view.lines).toEqual([]);
    expect(view.latestText).toBe("");
    expect(view.count).toBe(0);
  });

  it("is defensive against garbage entries and bad arguments", () => {
    const dirty = [
      entry(1, "good"),
      { day: 2 } as unknown as DiaryEntry, // missing text
      null as unknown as DiaryEntry,
      { text: "no day" } as unknown as DiaryEntry, // missing day
    ];
    const view = buildDiaryPanel(dirty, "Dora");
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].text).toBe("good");
    expect(view.count).toBe(1);

    // not an array, negative maxLines — never throws, yields a sane empty view
    const bad = buildDiaryPanel(undefined as unknown as DiaryEntry[], "Dora", -3);
    expect(bad.lines).toEqual([]);
    expect(bad.latestText).toBe("");
  });

  it("omits the phase suffix when the phase is empty", () => {
    const view = buildDiaryPanel([entry(4, "quiet day", "")], "Dora");
    expect(view.lines[0].label).toBe("Day 4: quiet day");
  });
});
