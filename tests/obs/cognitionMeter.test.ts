/**
 * Workstream B — pure formatter for the cognition-cost HUD meter.
 *
 * formatCognitionMeter(m) renders a compact tally for the badge row:
 *   `cog P{plan} R{reflect} I{importance} L{relationship} · {total}`.
 * null/undefined (mock or disabled cognition) → the zeroed form, never throws.
 */
import { describe, expect, it } from "vitest";
import type { CognitionMetrics } from "../../src/agents/Cognition";
import { formatCognitionMeter } from "../../src/obs/CognitionMeter";

describe("formatCognitionMeter", () => {
  it("null → zeroed text and total 0 (mock/disabled graceful)", () => {
    const out = formatCognitionMeter(null);
    expect(out.total).toBe(0);
    expect(out.text).toBe("cog P0 R0 I0 L0 · 0");
  });

  it("undefined → zeroed text and total 0", () => {
    const out = formatCognitionMeter(undefined);
    expect(out.total).toBe(0);
    expect(out.text).toBe("cog P0 R0 I0 L0 · 0");
  });

  it("populated → total + P# R# I# L# in order", () => {
    const m: CognitionMetrics = {
      planCalls: 3,
      reflectionCalls: 2,
      relationshipCalls: 5,
      importanceCalls: 7,
    };
    const out = formatCognitionMeter(m);
    expect(out.total).toBe(17);
    expect(out.text).toBe("cog P3 R2 I7 L5 · 17");
  });

  it("does not throw on a partial/garbage object (defensive)", () => {
    // Some fields missing — formatter coerces absent counts to 0.
    const partial = { planCalls: 4 } as unknown as CognitionMetrics;
    const out = formatCognitionMeter(partial);
    expect(out.total).toBe(4);
    expect(out.text).toBe("cog P4 R0 I0 L0 · 4");
  });
});
