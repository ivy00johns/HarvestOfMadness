/**
 * Kill-switch badge state machine (contract rule 13 — the demo's thesis).
 *
 * Three states, always exactly one visible on the HUD:
 *   - "live"    VITE_MODEL_MODE=live and the LLM path is healthy
 *   - "offline" live mode but an "llm_offline" event fired (until "llm_recovered")
 *   - "mock"    VITE_MODEL_MODE !== "live" — terminal; canned behavior by design
 *
 * Pure logic (no Phaser) so the live→offline→recovered transitions and the
 * mock latch are unit-testable. Colors are local to src/obs (config.ts is
 * render-agent's file).
 */
export type KillSwitchState = "live" | "offline" | "mock";

export class KillSwitchModel {
  private current: KillSwitchState;

  constructor(modelMode: string | undefined) {
    this.current = modelMode === "live" ? "live" : "mock";
  }

  state(): KillSwitchState {
    return this.current;
  }

  /**
   * Feed every bus event kind through; returns true when the badge state
   * changed (the HUD re-renders only then). Mock mode never transitions —
   * "llm_offline"/"llm_recovered" cannot fire meaningfully at $0 and must
   * not flip a mock badge to LIVE.
   */
  apply(kind: string): boolean {
    if (this.current === "mock") return false;
    if (kind === "llm_offline" && this.current !== "offline") {
      this.current = "offline";
      return true;
    }
    if (kind === "llm_recovered" && this.current === "offline") {
      this.current = "live";
      return true;
    }
    return false;
  }
}

export const KILL_SWITCH_LABELS: Record<KillSwitchState, string> = {
  live: "● LIVE",
  offline: "⚠ LLM OFFLINE — canned behavior",
  mock: "MOCK MODE — canned behavior",
};

/** High-contrast badge styling per state (CSS color strings for Phaser text). */
export const KILL_SWITCH_STYLES: Record<
  KillSwitchState,
  { fg: string; bg: string }
> = {
  live: { fg: "#9ece6a", bg: "#162612" },
  offline: { fg: "#ffffff", bg: "#a02828" },
  mock: { fg: "#101014", bg: "#e0af68" },
};

export function killSwitchLabel(s: KillSwitchState): string {
  return KILL_SWITCH_LABELS[s];
}

export function killSwitchStyle(s: KillSwitchState): { fg: string; bg: string } {
  return KILL_SWITCH_STYLES[s];
}
