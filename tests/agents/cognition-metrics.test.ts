/**
 * Workstream B — Cognition-cost HUD.
 *
 * Tests the read-only `metricsSnapshot()` getter added to CognitionSystem.
 * It must:
 *  - return all-zero counters on a fresh mock-mode system (mock never increments);
 *  - return a *copy* (mutating the snapshot must not corrupt the live metrics).
 *
 * Pure-model: no Phaser, no LLM, $0 mock mode only.
 */
import { describe, expect, it } from "vitest";
import type { CognitionMetrics } from "../../src/agents/Cognition";
import { CognitionSystem } from "../../src/agents/Cognition";

function makeStamp(day = 1) {
  return { day, phase: "morning" as const };
}

describe("CognitionSystem.metricsSnapshot()", () => {
  it("returns all-zero counters on a fresh mock-mode system", () => {
    const cog = new CognitionSystem({ live: () => false, now: makeStamp });
    const snap = cog.metricsSnapshot();
    expect(snap).toEqual<CognitionMetrics>({
      planCalls: 0,
      reflectionCalls: 0,
      relationshipCalls: 0,
      importanceCalls: 0,
    });
  });

  it("returns a copy — mutating the snapshot does not affect live metrics", () => {
    const cog = new CognitionSystem({ live: () => false, now: makeStamp });
    const snap = cog.metricsSnapshot() as CognitionMetrics;
    snap.planCalls = 999;
    snap.reflectionCalls = 999;
    snap.relationshipCalls = 999;
    snap.importanceCalls = 999;
    // The next snapshot reflects the untouched live metrics.
    expect(cog.metricsSnapshot()).toEqual<CognitionMetrics>({
      planCalls: 0,
      reflectionCalls: 0,
      relationshipCalls: 0,
      importanceCalls: 0,
    });
  });

  it("is a distinct object on each call (defensive copy)", () => {
    const cog = new CognitionSystem({ live: () => false, now: makeStamp });
    expect(cog.metricsSnapshot()).not.toBe(cog.metricsSnapshot());
  });
});
