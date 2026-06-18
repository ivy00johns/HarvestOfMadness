/**
 * PartyPanel — pure builder for the live party showcase strip.
 *
 * Turns an EventAttendanceSnapshot (from EventBoard) plus the scene-tracked set
 * of arrived agent names into a flat, render-ready view. This is a *standing*
 * snapshot that updates in place ("9/12 know") rather than scrolling feed lines.
 *
 * - knowLine    = "{knowerCount}/{townSize} know"
 * - invitedCount = snap.invited.length (host already excluded by EventBoard)
 * - arrivedCount = |knowers ∩ arrivedNames|  (arrivals sourced from the bus,
 *   NOT EventBoard — arrived lives in Cognition; see UIScene accumulation)
 * - names is the knower list capped to maxNames for the chrome
 *
 * Pure + defensive: no Phaser, never throws.
 */
import type { EventAttendanceSnapshot } from "../agents/EventBoard";

export interface PartyPanelView {
  description: string;
  host: string;
  location: { x: number; y: number };
  knowerCount: number;
  knowLine: string;
  invitedCount: number;
  arrivedCount: number;
  /** capped knower names for the chrome */
  names: string[];
}

export function buildPartyPanel(
  snap: EventAttendanceSnapshot,
  arrivedNames: ReadonlySet<string>,
  townSize: number,
  maxNames = 6,
): PartyPanelView {
  const knowers = snap.knowers;
  const arrivedCount = knowers.reduce(
    (acc, name) => acc + (arrivedNames.has(name) ? 1 : 0),
    0,
  );
  return {
    description: snap.event.description,
    host: snap.event.host,
    location: { x: snap.event.location.x, y: snap.event.location.y },
    knowerCount: snap.knowerCount,
    knowLine: `${snap.knowerCount}/${townSize} know`,
    invitedCount: snap.invited.length,
    arrivedCount,
    names: knowers.slice(0, Math.max(0, maxNames)),
  };
}
