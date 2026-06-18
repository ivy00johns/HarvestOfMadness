/**
 * Workstream B — pure builder for the live party showcase panel.
 *
 * buildPartyPanel(snap, arrivedNames, townSize, maxNames=6) → PartyPanelView:
 *   - knowLine "{knowerCount}/{townSize} know"
 *   - invitedCount = snap.invited.length
 *   - arrivedCount = |knowers ∩ arrivedNames|
 *   - name list capped to maxNames
 */
import { describe, expect, it } from "vitest";
import type { SimEvent } from "@contracts/types";
import { EventBoard } from "../../src/agents/EventBoard";
import { buildPartyPanel } from "../../src/obs/PartyPanel";

function makeEvent(overrides: Partial<SimEvent> = {}): SimEvent {
  return {
    id: "evt-party",
    host: "Alice",
    location: { x: 12, y: 8 },
    day: 2,
    phase: "evening",
    description: "a gathering at the tavern",
    ...overrides,
  };
}

/** Seed a board where `count` non-host agents know the event (plus the host). */
function seedKnowers(count: number): { board: EventBoard; evt: SimEvent } {
  const board = new EventBoard();
  const evt = makeEvent();
  board.seed(evt); // Alice (host) knows
  for (let i = 0; i < count; i++) board.markKnows(evt.id, `Guest${i}`);
  return { board, evt };
}

describe("buildPartyPanel", () => {
  it("8 guests + host → knowLine '9/12 know', invitedCount 8", () => {
    const { board, evt } = seedKnowers(8); // host + 8 = 9 knowers
    const snap = board.attendanceSnapshot(evt.id)!;
    const view = buildPartyPanel(snap, new Set<string>(), 12);
    expect(view.knowLine).toBe("9/12 know");
    expect(view.invitedCount).toBe(8); // host excluded
  });

  it("arrivedCount = |knowers ∩ arrivedNames|", () => {
    const { board, evt } = seedKnowers(8);
    const snap = board.attendanceSnapshot(evt.id)!;
    // Guest0..Guest2 + an unknown name + the host arrive.
    const arrived = new Set(["Guest0", "Guest1", "Guest2", "Stranger", "Alice"]);
    const view = buildPartyPanel(snap, arrived, 12);
    // Alice (host) is a knower too, so 3 guests + host = 4. "Stranger" not counted.
    expect(view.arrivedCount).toBe(4);
  });

  it("arrivedCount ignores names not in the knowers set", () => {
    const { board, evt } = seedKnowers(2);
    const snap = board.attendanceSnapshot(evt.id)!;
    const view = buildPartyPanel(snap, new Set(["Nobody", "Phantom"]), 12);
    expect(view.arrivedCount).toBe(0);
  });

  it("name list is capped to maxNames (default 6)", () => {
    const { board, evt } = seedKnowers(20); // far more than 6
    const snap = board.attendanceSnapshot(evt.id)!;
    const view = buildPartyPanel(snap, new Set<string>(), 24);
    expect(view.names.length).toBeLessThanOrEqual(6);
  });

  it("respects an explicit maxNames argument", () => {
    const { board, evt } = seedKnowers(20);
    const snap = board.attendanceSnapshot(evt.id)!;
    const view = buildPartyPanel(snap, new Set<string>(), 24, 3);
    expect(view.names.length).toBeLessThanOrEqual(3);
  });

  it("exposes description, host and location for chrome rendering", () => {
    const { board, evt } = seedKnowers(1);
    const snap = board.attendanceSnapshot(evt.id)!;
    const view = buildPartyPanel(snap, new Set<string>(), 12);
    expect(view.description).toBe(evt.description);
    expect(view.host).toBe(evt.host);
  });
});
