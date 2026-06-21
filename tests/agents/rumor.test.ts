/**
 * Rumor distortion (INTENSIFY) — pure-module teeth for src/agents/rumor.ts.
 *
 * Asserts only the OBSERVABLE properties (not the exact amplifier wording, so
 * the strings can be tuned without churning this test):
 *   - hop 1 (and hop <= 1) returns the claim byte-identical.
 *   - hop 2 differs from the claim; hop 3 differs from hop 2 and ESCALATES.
 *   - claim-agnostic: an arbitrary claim string also intensifies (no fixture
 *     coupling, never throws, the original claim is always preserved verbatim
 *     inside the intensified form — no NLP / content surgery).
 *   - empty / odd input is safe (never throws).
 *   - determinism: same (claim, hop) ⇒ same output across calls.
 *   - source-grep: zero Math.random / Date in rumor.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUMOR_INTENSIFIERS, intensifyClaim } from "../../src/agents/rumor";

const FIXTURE = "I found a treasure chest buried near the well";

describe("rumor — intensifyClaim (INTENSIFY distortion)", () => {
  it("hop 1 returns the claim byte-identical (faithful first-hand)", () => {
    expect(intensifyClaim(FIXTURE, 1)).toBe(FIXTURE);
  });

  it("hop <= 1 (0, negative) also returns the claim unchanged", () => {
    expect(intensifyClaim(FIXTURE, 0)).toBe(FIXTURE);
    expect(intensifyClaim(FIXTURE, -3)).toBe(FIXTURE);
  });

  it("hop 2 amplifies the claim (differs from the canonical claim)", () => {
    const h2 = intensifyClaim(FIXTURE, 2);
    expect(h2).not.toBe(FIXTURE);
    // The canonical claim is preserved verbatim inside the amplified form.
    expect(h2).toContain(FIXTURE);
  });

  it("hop 3 escalates VISIBLY beyond hop 2 (differs and is stronger/longer)", () => {
    const h2 = intensifyClaim(FIXTURE, 2);
    const h3 = intensifyClaim(FIXTURE, 3);
    expect(h3).not.toBe(h2);
    expect(h3).toContain(FIXTURE);
    // Escalation is observable: the hop-3 amplifier adds more than hop 2.
    expect(h3.length).toBeGreaterThan(h2.length);
  });

  it("is claim-agnostic: a totally different claim also intensifies cleanly", () => {
    const other = "the bridge by the mill collapsed last night";
    const h1 = intensifyClaim(other, 1);
    const h2 = intensifyClaim(other, 2);
    const h3 = intensifyClaim(other, 3);
    expect(h1).toBe(other);
    expect(h2).not.toBe(other);
    expect(h2).toContain(other);
    expect(h3).not.toBe(h2);
    expect(h3).toContain(other);
    expect(h3.length).toBeGreaterThan(h2.length);
  });

  it("is safe on empty / whitespace / odd input (never throws)", () => {
    expect(() => intensifyClaim("", 1)).not.toThrow();
    expect(intensifyClaim("", 1)).toBe("");
    expect(() => intensifyClaim("", 2)).not.toThrow();
    expect(() => intensifyClaim("   ", 3)).not.toThrow();
    // Non-finite / huge hop clamps safely to the top of the ladder, no throw.
    expect(() => intensifyClaim(FIXTURE, Number.NaN)).not.toThrow();
    expect(intensifyClaim(FIXTURE, Number.NaN)).toBe(FIXTURE);
    expect(() => intensifyClaim(FIXTURE, 99)).not.toThrow();
    expect(intensifyClaim(FIXTURE, 99)).toBe(intensifyClaim(FIXTURE, 3));
  });

  it("is deterministic: same (claim, hop) ⇒ same output across calls", () => {
    for (const hop of [1, 2, 3, 4]) {
      expect(intensifyClaim(FIXTURE, hop)).toBe(intensifyClaim(FIXTURE, hop));
    }
  });

  it("exposes a hop-2 and hop-3 amplifier in the ladder", () => {
    expect(RUMOR_INTENSIFIERS[2]).toBeDefined();
    expect(RUMOR_INTENSIFIERS[3]).toBeDefined();
  });

  it("source-grep: rumor.ts contains no Math.random / Date (deterministic)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/agents/rumor.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\bnew Date\b/);
    expect(src).not.toMatch(/Date\.now/);
  });
});
