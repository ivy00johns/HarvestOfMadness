/**
 * Phase C · Slice C1 — warmth-only sentiment (pure-module teeth).
 *
 * Pins the OBSERVABLE properties of warmthBonus (the lexicon word-list itself is
 * NOT pinned word-for-word — only behavior):
 *  - neutral / curt mock variants score 0 (so the frozen "+2 after a 4-turn
 *    convo" assertion holds; the bare default "Good to hear" must NOT score);
 *  - genuinely warm copy scores, scaling with warm-token count;
 *  - the bonus clamps at WARMTH_BONUS_CAP;
 *  - empty / blank transcripts return 0 without throwing;
 *  - determinism (same input ⇒ same output);
 *  - source has zero Math.random / Date / Date.now (warmth-only is deterministic).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "@contracts/types";
import { WARMTH_BONUS_CAP, warmthBonus } from "../../src/agents/sentiment";

const t = (...texts: string[]): ConversationTurn[] =>
  texts.map((text, i) => ({ speaker: i % 2 === 0 ? "Alice" : "Bob", text }));

describe("warmthBonus — neutral / curt transcripts score 0", () => {
  it("the grumbling mock variants score 0", () => {
    expect(warmthBonus(t("Hmph. If you say so.", "Fine. Anything else?"))).toBe(0);
    expect(warmthBonus(t("Right. Goodbye then."))).toBe(0);
  });

  it("the DEFAULT persona acknowledgement 'Good to hear' scores 0 (bare 'good' is excluded)", () => {
    // This is the line that appears in nearly every 4-turn convo whose A is a
    // plain farmer — it MUST stay 0 so the frozen grumbling +2 assertion holds.
    expect(warmthBonus(t("Good to hear, Bob.", "Is that so, Bob?", "Well, take care, Bob."))).toBe(0);
  });

  it("the full grumbling 4-turn transcript scores 0", () => {
    expect(
      warmthBonus(
        t("Tell me everything!", "Hmph. If you say so.", "Good to hear, Bob.", "Fine. Anything else?"),
      ),
    ).toBe(0);
  });

  it("frugal / reckless / nervous neutral variants score 0", () => {
    expect(warmthBonus(t("Mind the costs, Alice. Every copper counts."))).toBe(0);
    expect(warmthBonus(t("Ha! Sure thing, let's do it!", "Why not — count me in!"))).toBe(0);
    expect(warmthBonus(t("Oh — yes, of course, Alice! I'll keep that in mind."))).toBe(0);
  });
});

describe("warmthBonus — warm transcripts score > 0, scaling with count", () => {
  it("a single warm word scores 1", () => {
    expect(warmthBonus(t("friend"))).toBe(1);
  });

  it("scales with the warm-token count", () => {
    expect(warmthBonus(t("dear friend"))).toBe(2);
    expect(warmthBonus(t("dear friend glad"))).toBe(3);
  });

  it("counts warm words across multiple turns", () => {
    expect(warmthBonus(t("Hello dear friend!", "Such wondrous thoughts, Alice — go on."))).toBe(3);
  });

  it("warm words are matched case-insensitively as whole tokens", () => {
    expect(warmthBonus(t("FRIEND, what a DELIGHT"))).toBe(2);
    // substring (not a whole token) must NOT match — 'befriended' is not 'friend'
    expect(warmthBonus(t("they befriended the warmhearted neighbor"))).toBe(0);
  });
});

describe("warmthBonus — clamp at WARMTH_BONUS_CAP", () => {
  it("a transcript stuffed with warm words clamps to the cap", () => {
    const stuffed = "friend dear glad happy joy love kind warm hope smile delight";
    expect(warmthBonus(t(stuffed))).toBe(WARMTH_BONUS_CAP);
    expect(WARMTH_BONUS_CAP).toBe(6);
  });

  it("never exceeds the cap even across all turns", () => {
    expect(
      warmthBonus(t("friend dear glad", "happy joy love", "kind warm hope")),
    ).toBe(WARMTH_BONUS_CAP);
  });
});

describe("warmthBonus — empty / degenerate inputs", () => {
  it("empty transcript returns 0", () => {
    expect(warmthBonus([])).toBe(0);
  });

  it("empty / whitespace turn texts return 0 without throwing", () => {
    expect(warmthBonus(t("", "   "))).toBe(0);
  });

  it("non-array input returns 0", () => {
    // Defensive: non-array / malformed input must not throw.
    expect(warmthBonus(undefined as unknown as ConversationTurn[])).toBe(0);
  });
});

describe("warmthBonus — determinism", () => {
  it("same input ⇒ same output across repeated calls", () => {
    const turns = t("Hello dear friend!", "Such wondrous thoughts, Alice — go on.");
    const a = warmthBonus(turns);
    const b = warmthBonus(turns);
    const c = warmthBonus(turns);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("sentiment.ts — source is deterministic (no RNG / Date)", () => {
  it("the module source contains zero Math.random / new Date / Date.now", () => {
    const src = readFileSync(resolve(__dirname, "../../src/agents/sentiment.ts"), "utf8");
    expect(/Math\.random/.test(src)).toBe(false);
    expect(/new Date/.test(src)).toBe(false);
    expect(/Date\.now/.test(src)).toBe(false);
  });
});
