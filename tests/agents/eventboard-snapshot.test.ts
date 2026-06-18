/**
 * Workstream B — Live party showcase data seam.
 *
 * Tests the read-only `attendanceSnapshot()` getter + EventAttendanceSnapshot
 * interface added to EventBoard. It must:
 *  - return undefined for an unknown event id;
 *  - for a host-only seeded event: knowerCount 1, invited [] (host excluded);
 *  - after two markKnows: knowerCount 3, invited excludes the host;
 *  - never mutate the underlying board.
 *
 * Pure-model: no Phaser, no LLM.
 */
import { describe, expect, it } from "vitest";
import type { SimEvent } from "@contracts/types";
import { EventBoard } from "../../src/agents/EventBoard";

function makeEvent(overrides: Partial<SimEvent> = {}): SimEvent {
  return {
    id: "evt-1",
    host: "Alice",
    location: { x: 10, y: 5 },
    day: 2,
    phase: "evening",
    description: "a gathering at the tavern",
    ...overrides,
  };
}

describe("EventBoard.attendanceSnapshot()", () => {
  it("returns undefined for an unknown event id", () => {
    const board = new EventBoard();
    expect(board.attendanceSnapshot("no-such-id")).toBeUndefined();
  });

  it("host-only seeded event → knowerCount 1, invited [] (host excluded)", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    const snap = board.attendanceSnapshot(evt.id);
    expect(snap).toBeDefined();
    expect(snap!.event).toEqual(evt);
    expect(snap!.knowerCount).toBe(1);
    expect(snap!.knowers).toEqual(["Alice"]);
    expect(snap!.invited).toEqual([]);
  });

  it("after markKnows ×2 → knowerCount 3, invited excludes the host", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    board.markKnows(evt.id, "Bob");
    board.markKnows(evt.id, "Carol");
    const snap = board.attendanceSnapshot(evt.id)!;
    expect(snap.knowerCount).toBe(3);
    expect(snap.knowers).toContain("Alice");
    expect(snap.knowers).toContain("Bob");
    expect(snap.knowers).toContain("Carol");
    expect(snap.invited).not.toContain("Alice");
    expect(snap.invited).toContain("Bob");
    expect(snap.invited).toContain("Carol");
    expect(snap.invited).toHaveLength(2);
  });

  it("is non-mutating — reading the snapshot does not change board state", () => {
    const board = new EventBoard();
    const evt = makeEvent();
    board.seed(evt);
    board.markKnows(evt.id, "Bob");
    const before = board.knowerCount(evt.id);
    const snap = board.attendanceSnapshot(evt.id)!;
    // Mutating the returned arrays must not leak into the board.
    snap.knowers.push("Mallory");
    snap.invited.push("Mallory");
    expect(board.knowerCount(evt.id)).toBe(before);
    expect(board.knows(evt.id, "Mallory")).toBe(false);
    expect(board.attendanceSnapshot(evt.id)!.knowerCount).toBe(before);
  });
});
