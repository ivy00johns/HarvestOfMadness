/**
 * SpaceCon design tokens — the SINGLE source of truth for the HUD's color +
 * type palette (the "SpaceCon Feedback Design System", cool-navy mission-control
 * look). Pure data, no Phaser import, so it is freely consumable by config.ts,
 * layout.ts, UIScene.ts AND the headless token test.
 *
 * Every SpaceCon hex lives here and ONLY here. The existing `COLOR_*` /
 * `FSM_COLORS` constants in UIScene and `BACKGROUND_COLOR` in config derive
 * their values from this module (keeping their names so existing usages pick up
 * the navy palette) — see contracts/phase-b-foundation.md §Retheme map.
 *
 * Each color is provided in BOTH forms:
 *   - number `0xRRGGBB` — for Phaser `fillStyle`/`lineStyle`/Rectangle.
 *   - string `#RRGGBB` — for Phaser text-style `color`.
 * Values are pinned verbatim from the design handoff (§Design Tokens) and locked
 * by tests/obs/theme.test.ts so later Phase B slices can't silently drift.
 */

/** A single token in both Phaser forms. `num` for geometry, `hex` for text. */
export interface ColorToken {
  /** 0xRRGGBB — Phaser fillStyle / lineStyle / Rectangle. */
  num: number;
  /** "#RRGGBB" — Phaser text-style color. */
  hex: string;
}

/** Internal helper: derive the string form from the number form (single source
 *  per token — the hex literal is written once, as the number). */
function tok(num: number): ColorToken {
  return { num, hex: `#${num.toString(16).padStart(6, "0").toUpperCase()}` };
}

// -- Surfaces / neutrals ------------------------------------------------------
export const appBg = tok(0x0b1220); // App/canvas bg (--ink-900)
export const mapBg = tok(0x0d1626); // Map viewport bg
export const cmdGradTop = tok(0x10192b); // command-bar gradient top
export const cmdGradBot = tok(0x0d1424); // command-bar gradient bottom
export const card = tok(0x111c30); // card surface
export const cardSelected = tok(0x15233c); // selected card surface
export const insetTile = tok(0x0d1626); // inset tiles
export const control = tok(0x0c1424); // control containers
export const borderCard = tok(0x1f2c46); // card border
export const borderControl = tok(0x24324d); // control border
export const borderInspector = tok(0x2f4a6b); // inspector border
export const divider = tok(0x1c2840); // divider / track

export const white = tok(0xffffff);
export const ink300 = tok(0xa7b0c0); // body
export const ink400 = tok(0x76839b); // labels
export const ink500 = tok(0x51607c); // faint

// -- Brand / accents ----------------------------------------------------------
export const brand600 = tok(0x1e50c8); // active fills
export const brand500 = tok(0x2a63e0); // selected border
export const brand400 = tok(0x5187f2);
export const cyan500 = tok(0x2aa9d6);
export const cyan300 = tok(0x7fd3ec);
export const positive500 = tok(0x18996f);
export const p2 = tok(0xd9892b); // amber (P2)
export const p1 = tok(0xd64550); // red (P1)
export const statusDecision = tok(0x6a4bc2); // violet

// -- Semantic tints (badge fills — { color, alpha: 0.16 }) --------------------
/** A badge-fill tint: a fill color plus the fixed SpaceCon badge alpha. */
export interface Tint {
  color: number;
  alpha: number;
}

/** The SpaceCon badge tint alpha (16%) — every semantic tint uses it. */
export const TINT_ALPHA = 0.16;

export const tintExec: Tint = { color: 0x137e5c, alpha: TINT_ALPHA };
export const tintThink: Tint = { color: 0xb9760f, alpha: TINT_ALPHA };
export const tintIdle: Tint = { color: 0x51607c, alpha: TINT_ALPHA };
export const tintReflect: Tint = { color: 0x2aa9d6, alpha: TINT_ALPHA };
export const tintPlan: Tint = { color: 0x1e50c8, alpha: TINT_ALPHA };
/** OBS tag chip fill (opaque, not a 0.16 tint). */
export const obsTagFill = tok(0x1f2c46);

// -- Type — font-family stacks ------------------------------------------------
/** Display — names, numbers, titles, headers. */
export const FONT_DISPLAY = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
/** Body — goals, thought/quote, persona, chat. */
export const FONT_BODY = "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif";
/** Mono — labels, telemetry, IDs, badges. */
export const FONT_MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";

// -- Radius (for later slices; exported now) ----------------------------------
export const RADIUS = { control: 8, card: 13, badge: 5, bar: 4 } as const;
