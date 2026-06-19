/**
 * SpaceCon design-token lock (contracts/phase-b-foundation.md §Tests).
 *
 * Pins every token to its documented value in BOTH forms (0xRRGGBB number and
 * "#RRGGBB" string), asserts the three font stacks name Space Grotesk / IBM Plex
 * Sans / IBM Plex Mono FIRST, and asserts the semantic-tint alphas are 0.16.
 * This locks the palette so later Phase B slices can't silently drift, and so
 * the COLOR_* / FSM_COLORS / BACKGROUND_COLOR constants that derive from it stay
 * anchored. Pure module — no Phaser needed.
 */
import { describe, expect, it } from "vitest";
import {
  FONT_BODY,
  FONT_DISPLAY,
  FONT_MONO,
  RADIUS,
  TINT_ALPHA,
  appBg,
  borderCard,
  borderControl,
  borderInspector,
  brand400,
  brand500,
  brand600,
  bubbleGuest,
  bubbleHost,
  card,
  cardSelected,
  cmdGradBot,
  cmdGradTop,
  control,
  cyan300,
  cyan500,
  divider,
  ink300,
  ink400,
  ink500,
  insetTile,
  mapBg,
  obsTagFill,
  p1,
  p2,
  positive500,
  statusDecision,
  tintExec,
  tintIdle,
  tintPlan,
  tintReflect,
  tintThink,
  white,
  type ColorToken,
} from "../../src/obs/theme";

/** Every color token, with its documented number + string form. */
const COLOR_CASES: ReadonlyArray<[string, ColorToken, number, string]> = [
  // Surfaces / neutrals
  ["appBg", appBg, 0x0b1220, "#0B1220"],
  ["mapBg", mapBg, 0x0d1626, "#0D1626"],
  ["cmdGradTop", cmdGradTop, 0x10192b, "#10192B"],
  ["cmdGradBot", cmdGradBot, 0x0d1424, "#0D1424"],
  ["card", card, 0x111c30, "#111C30"],
  ["cardSelected", cardSelected, 0x15233c, "#15233C"],
  ["insetTile", insetTile, 0x0d1626, "#0D1626"],
  ["control", control, 0x0c1424, "#0C1424"],
  ["borderCard", borderCard, 0x1f2c46, "#1F2C46"],
  ["borderControl", borderControl, 0x24324d, "#24324D"],
  ["borderInspector", borderInspector, 0x2f4a6b, "#2F4A6B"],
  ["divider", divider, 0x1c2840, "#1C2840"],
  ["white", white, 0xffffff, "#FFFFFF"],
  ["ink300", ink300, 0xa7b0c0, "#A7B0C0"],
  ["ink400", ink400, 0x76839b, "#76839B"],
  ["ink500", ink500, 0x51607c, "#51607C"],
  // Chat bubble tints (Active-conversation card, README §5)
  ["bubbleHost", bubbleHost, 0x16243c, "#16243C"],
  ["bubbleGuest", bubbleGuest, 0x1d2336, "#1D2336"],
  // Brand / accents
  ["brand600", brand600, 0x1e50c8, "#1E50C8"],
  ["brand500", brand500, 0x2a63e0, "#2A63E0"],
  ["brand400", brand400, 0x5187f2, "#5187F2"],
  ["cyan500", cyan500, 0x2aa9d6, "#2AA9D6"],
  ["cyan300", cyan300, 0x7fd3ec, "#7FD3EC"],
  ["positive500", positive500, 0x18996f, "#18996F"],
  ["p2", p2, 0xd9892b, "#D9892B"],
  ["p1", p1, 0xd64550, "#D64550"],
  ["statusDecision", statusDecision, 0x6a4bc2, "#6A4BC2"],
  ["obsTagFill", obsTagFill, 0x1f2c46, "#1F2C46"],
];

describe("SpaceCon color tokens", () => {
  it.each(COLOR_CASES)(
    "%s pins its number + string form",
    (_name, token, num, hex) => {
      expect(token.num).toBe(num);
      expect(token.hex).toBe(hex);
      // string form is the upper-case hex of the number form (single source).
      expect(token.hex).toBe(`#${num.toString(16).padStart(6, "0").toUpperCase()}`);
    },
  );
});

describe("SpaceCon semantic tints", () => {
  const TINT_CASES: ReadonlyArray<[string, { color: number; alpha: number }, number]> = [
    ["exec", tintExec, 0x137e5c],
    ["think", tintThink, 0xb9760f],
    ["idle", tintIdle, 0x51607c],
    ["reflect", tintReflect, 0x2aa9d6],
    ["plan", tintPlan, 0x1e50c8],
  ];

  it.each(TINT_CASES)("%s tint has the documented color + 0.16 alpha", (_n, tint, color) => {
    expect(tint.color).toBe(color);
    expect(tint.alpha).toBe(0.16);
  });

  it("the shared badge tint alpha is 0.16", () => {
    expect(TINT_ALPHA).toBe(0.16);
  });
});

describe("SpaceCon font stacks", () => {
  it("display stack names Space Grotesk first", () => {
    expect(FONT_DISPLAY).toBe(
      "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
    );
    expect(FONT_DISPLAY.startsWith("'Space Grotesk'")).toBe(true);
  });

  it("body stack names IBM Plex Sans first", () => {
    expect(FONT_BODY).toBe(
      "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    );
    expect(FONT_BODY.startsWith("'IBM Plex Sans'")).toBe(true);
  });

  it("mono stack names IBM Plex Mono first", () => {
    expect(FONT_MONO).toBe(
      "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
    );
    expect(FONT_MONO.startsWith("'IBM Plex Mono'")).toBe(true);
  });
});

describe("SpaceCon radii", () => {
  it("pins the radius scale for later slices", () => {
    expect(RADIUS).toEqual({ control: 8, card: 13, badge: 5, bar: 4 });
  });
});
