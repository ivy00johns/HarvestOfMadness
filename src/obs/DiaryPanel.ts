/**
 * DiaryPanel — pure builder for the agent diary view (mirrors PartyPanel /
 * GovernancePanel). Turns a list of DiaryEntry into a render-ready view of the
 * latest entries, NEWEST-FIRST and capped, so the player can read an agent's
 * recent journal at a glance.
 *
 * Pure + defensive: no Phaser, never throws.
 */
import type { DiaryEntry } from "@contracts/types";

export interface DiaryPanelLine {
  day: number;
  phase: string;
  text: string;
  /** "Day N (phase): <text>" — one render-ready chrome line. */
  label: string;
}

export interface DiaryPanelView {
  agentName: string;
  /** latest entries, newest-first, capped to maxLines */
  lines: DiaryPanelLine[];
  /** the single newest entry's text, or "" when there are none */
  latestText: string;
  /** total entries available for this agent (before the cap) */
  count: number;
}

export function buildDiaryPanel(
  entries: DiaryEntry[],
  agentName: string,
  maxLines = 5,
): DiaryPanelView {
  const safe = Array.isArray(entries) ? entries : [];
  // Keep only well-shaped rows, then newest-first (entries arrive oldest-first).
  const cleaned = safe.filter(
    (e) => e && typeof e.text === "string" && typeof e.day === "number",
  );
  const newestFirst = cleaned.slice().reverse();
  const cap = Math.max(0, maxLines);
  const lines: DiaryPanelLine[] = newestFirst.slice(0, cap).map((e) => {
    const phase = typeof e.phase === "string" ? e.phase : "";
    return {
      day: e.day,
      phase,
      text: e.text,
      label: `Day ${e.day}${phase ? ` (${phase})` : ""}: ${e.text}`,
    };
  });
  return {
    agentName,
    lines,
    latestText: newestFirst.length > 0 ? newestFirst[0].text : "",
    count: cleaned.length,
  };
}
