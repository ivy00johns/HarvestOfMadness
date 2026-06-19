/**
 * Pure speech-bubble cap policy (Phase B-4, contracts/phase-b-map-overlays.md
 * §5). Teeth: the selected speaker is ALWAYS kept, the total cap is respected,
 * ambient bubbles are the MOST-RECENT other speakers, and the null-selected
 * case is the cap most-recent speakers. No Phaser — pure data → names.
 */
import { describe, expect, it } from "vitest";
import { visibleBubbleAgents, type SpeakingAgent } from "../../src/obs/bubblePolicy";

const speaking = (entries: Array<[string, number]>): SpeakingAgent[] =>
  entries.map(([name, t]) => ({ name, t }));

describe("visibleBubbleAgents", () => {
  it("keeps the selected speaker first, even when it is the OLDEST", () => {
    const s = speaking([
      ["Ana", 100],
      ["Bo", 90],
      ["Cy", 80],
      ["Dee", 10], // oldest
    ]);
    const out = visibleBubbleAgents(s, "Dee", 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("Dee"); // selected always present + first
    // remaining slots = the two most-recent OTHERS (Ana, Bo), Cy dropped.
    expect(out.slice(1)).toEqual(["Ana", "Bo"]);
    expect(out).not.toContain("Cy");
  });

  it("respects the cap (default 3 = selected + 2 ambient)", () => {
    const s = speaking([
      ["Ana", 50],
      ["Bo", 40],
      ["Cy", 30],
      ["Dee", 20],
      ["Eve", 10],
    ]);
    const out = visibleBubbleAgents(s, "Eve"); // default cap 3
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("Eve");
    expect(out.slice(1)).toEqual(["Ana", "Bo"]); // 2 most-recent others
  });

  it("ambient bubbles are the most-recent speakers when nothing is selected", () => {
    const s = speaking([
      ["Ana", 1],
      ["Bo", 5],
      ["Cy", 9],
      ["Dee", 7],
    ]);
    const out = visibleBubbleAgents(s, null, 2);
    expect(out).toEqual(["Cy", "Dee"]); // top-2 by recency, newest first
  });

  it("null-selected with a small crowd just returns everyone (within cap)", () => {
    const s = speaking([["Ana", 3], ["Bo", 2]]);
    expect(visibleBubbleAgents(s, null, 3)).toEqual(["Ana", "Bo"]);
  });

  it("selected agent that is NOT speaking does not force a slot", () => {
    const s = speaking([
      ["Ana", 30],
      ["Bo", 20],
      ["Cy", 10],
    ]);
    // "Zed" is selected but not in the speaking set → behaves like null-selected.
    const out = visibleBubbleAgents(s, "Zed", 2);
    expect(out).toEqual(["Ana", "Bo"]);
    expect(out).not.toContain("Zed");
  });

  it("never duplicates the selected agent and never exceeds the cap", () => {
    const s = speaking([
      ["Ana", 30],
      ["Bo", 20],
      ["Cy", 10],
    ]);
    const out = visibleBubbleAgents(s, "Ana", 2);
    expect(out).toEqual(["Ana", "Bo"]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("cap of 0 yields no bubbles; negative cap clamps to 0", () => {
    const s = speaking([["Ana", 1]]);
    expect(visibleBubbleAgents(s, "Ana", 0)).toEqual([]);
    expect(visibleBubbleAgents(s, "Ana", -5)).toEqual([]);
  });

  it("breaks recency ties deterministically by name", () => {
    const s = speaking([
      ["Bo", 5],
      ["Ana", 5], // same t as Bo
      ["Cy", 5],
    ]);
    expect(visibleBubbleAgents(s, null, 2)).toEqual(["Ana", "Bo"]);
  });
});
