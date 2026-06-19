/**
 * Pure SpaceCon agent-card style helpers (no Phaser import, headlessly testable).
 *
 * These resolve the three per-card visual rules the design handoff (§4) spells
 * out — the FSM state badge, the action-verb color, and the energy-bar color by
 * level. They take plain data and return theme tokens, so UIScene's card draw
 * (and any other surface that needs the same rule) reads ONE source of truth.
 *
 * In particular `energyLevelColor` is the SINGLE source of the energy-color
 * rule (>55% positive / >25% amber / else red) — this aligns the card, the KPI
 * band and the command bar to design §4 and resolves the deferred B-0 threshold
 * (the pre-B-5 card used a >50% cutoff). Reuse this helper anywhere the energy
 * color is computed; never re-inline the thresholds.
 */
import {
  brand400,
  cyan300,
  ink400,
  p1,
  p2,
  positive500,
  tintExec,
  tintIdle,
  tintThink,
  type Tint,
} from "./theme";

/** A resolved state-badge style: an uppercase label, a text color, and the
 *  semantic tint fill behind it (the SpaceCon 0.16-alpha pill). */
export interface StateBadgeStyle {
  /** Uppercase badge text (the FSM state). */
  label: string;
  /** Badge text + glyph color (theme token `num`). */
  color: number;
  /** Pill fill behind the label (a semantic tint from theme.ts). */
  tint: Tint;
}

/**
 * The FSM state badge style (design §4):
 *   EXECUTING → "EXECUTING", positive500 on the exec tint.
 *   THINKING  → "THINKING",  p2 (amber)  on the think tint.
 *   IDLE / anything else → "IDLE", ink400 on the idle tint.
 */
export function stateBadge(fsm: string): StateBadgeStyle {
  switch (fsm) {
    case "EXECUTING":
      return { label: "EXECUTING", color: positive500.num, tint: tintExec };
    case "THINKING":
      return { label: "THINKING", color: p2.num, tint: tintThink };
    default:
      return { label: "IDLE", color: ink400.num, tint: tintIdle };
  }
}

/**
 * Action-row color BY VERB (design §4):
 *   TALK_* (startsWith "TALK") → cyan300.
 *   WAIT                       → ink400.
 *   everything else            → brand400.
 */
export function actionVerbColor(action: string): number {
  if (action.startsWith("TALK")) return cyan300.num;
  if (action === "WAIT") return ink400.num;
  return brand400.num;
}

/**
 * Energy-bar fill color by level (design §4 — the SINGLE source of this rule):
 *   ratio > 0.55 → positive500.
 *   ratio > 0.25 → p2 (amber).
 *   else         → p1 (red).
 * `ratio` is energy / 100 in [0, 1].
 */
export function energyLevelColor(ratio: number): number {
  if (ratio > 0.55) return positive500.num;
  if (ratio > 0.25) return p2.num;
  return p1.num;
}
