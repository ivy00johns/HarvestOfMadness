/**
 * Pure per-hamlet roof/wall TINT — no Phaser dependency, headless-testable.
 *
 * The primary render mode is the open-roof cutaway, so a house has no closed
 * roof to tint; its visible color identity is the timber WALL RING plus the
 * wood-plank FLOOR that fills the interior (and, in the degraded closed-facade
 * fallback, the red-brick facade). This module gives each of the five hamlets a
 * distinct wash that multiplies onto those warm textures (so the texture still
 * reads through), making the four corners (NW/NE/SW/SE) and the central
 * Greenhollow terrace read as different neighbourhoods at a glance.
 *
 * This is SEPARATE from buildingStyle(kind) (which keeps house=0xffffff): the
 * hamlet tint is derived purely from a building's footprint CENTER (tile
 * coords), so it stays render-only and data-shape-stable — no `hamlet` field on
 * any spec. Pure + deterministic: no RNG, no wall-clock reads.
 */

export type Hamlet = "nw" | "ne" | "sw" | "se" | "central";

/**
 * Per-hamlet tint — a wash multiplied onto the warm timber wall ring, the house
 * floor, and (degraded mode) the red-brick facade, so the underlying texture
 * still reads while the neighbourhood color reads at a glance.
 */
export const HAMLET_ROOF_TINTS: Record<Hamlet, number> = {
  nw: 0xe49873, // terracotta-red
  ne: 0x8fb4e0, // cornflower blue
  sw: 0xe6c259, // golden ochre
  se: 0xd58cbe, // rose / orchid
  central: 0x6fceb6, // teal-green (Greenhollow)
};

/**
 * Classify a building CENTER (tile coords) into its hamlet by the Option-C
 * geography: west corners cx<50, east corners cx>110, the central Greenhollow
 * terrace between; north cy<50, south cy≥50.
 */
export function hamletOf(cx: number, cy: number): Hamlet {
  const west = cx < 50;
  const east = cx > 110;
  if (west) return cy < 50 ? "nw" : "sw";
  if (east) return cy < 50 ? "ne" : "se";
  return "central";
}

/** Resolve a building CENTER (tile coords) straight to its hamlet tint. */
export function hamletRoofTint(cx: number, cy: number): number {
  return HAMLET_ROOF_TINTS[hamletOf(cx, cy)];
}
