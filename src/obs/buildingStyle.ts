/**
 * Pure building-kind style map — no Phaser dependency, headless unit-testable.
 *
 * Returns a wall/roof tint (hex number, applied via Phaser setTint on the
 * facade sprites) and a sign emoji displayed above the building roof to make
 * each kind instantly distinguishable before dedicated art ships.
 *
 * Tint design:
 *   house   — warm red-brick (no tint, neutral white = 0xffffff)
 *   shop    — cool slate-blue  (general store)
 *   tavern  — amber-brown      (café / social hub)
 *   library — soft sage-green  (future community building)
 *   school  — light grey-blue  (future community building)
 */

export type BuildingKind = "house" | "shop" | "tavern" | "library" | "school";

export interface BuildingStyle {
  /** Phaser-compatible 0xRRGGBB tint (0xffffff = no tint / neutral) */
  tint: number;
  /** Single emoji or short string shown as a roof sign above the building */
  sign: string;
}

const STYLES: Record<BuildingKind, BuildingStyle> = {
  house:   { tint: 0xffffff, sign: "🏠" },
  shop:    { tint: 0xaabbdd, sign: "🛒" },
  tavern:  { tint: 0xddbb88, sign: "🍺" },
  library: { tint: 0xaaddbb, sign: "📚" },
  school:  { tint: 0xbbccdd, sign: "🏫" },
};

/**
 * Return the visual style for a building kind. Falls back to the house style
 * for any unknown kind so the renderer never crashes on future additions.
 */
export function buildingStyle(kind: string): BuildingStyle {
  return STYLES[kind as BuildingKind] ?? STYLES.house;
}
