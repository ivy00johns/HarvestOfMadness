/**
 * Speech-bubble visibility policy — PURE (no Phaser), so the cap rule is
 * unit-testable headlessly.
 *
 * Phase B-4 (contracts/phase-b-map-overlays.md §5): with a crowd clustered at
 * the tavern, every speaker's in-world 💬 bubble stacking at once turns the map
 * into soup. We cap the number of CONCURRENTLY-VISIBLE bubbles to the SELECTED
 * agent (always kept if it is speaking) plus the most-recent few OTHER speakers,
 * up to a total cap.
 *
 * WorldScene tracks the currently-speaking agents (each with a recency key `t`,
 * e.g. the timestamp the bubble was (re)shown) and consults
 * `visibleBubbleAgents()` to decide which bubbles to render.
 */

/** One currently-speaking agent: its name + a recency key (higher = more recent). */
export interface SpeakingAgent {
  name: string;
  /** recency key — higher means more recently spoke (e.g. a timestamp). */
  t: number;
}

/**
 * Decide which speaking agents' bubbles should render, capped to `cap` total.
 *
 * Rules:
 *  - The SELECTED agent's bubble is ALWAYS kept when it is currently speaking
 *    (it never counts against the others being dropped — selected is priority).
 *  - The remaining slots (up to `cap`) are filled by the most-recent OTHER
 *    speakers (highest `t` first).
 *  - When nothing is selected (or the selected agent is not speaking), the cap
 *    is simply the `cap` most-recent speakers.
 *
 * Returns the kept agent NAMES (order: selected first when present, then the
 * chosen others by descending recency). Never returns more than `cap` names.
 *
 * Defensive: `cap` is clamped to ≥ 0; ties on `t` break by name (stable,
 * deterministic) so the same crowd always yields the same bubbles.
 */
export function visibleBubbleAgents(
  speaking: ReadonlyArray<SpeakingAgent>,
  selected: string | null,
  cap = 3,
): string[] {
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0) return [];

  // Sort a copy by recency (newest first); deterministic tie-break by name.
  const byRecency = [...speaking].sort((a, b) => (b.t - a.t) || a.name.localeCompare(b.name));

  const kept: string[] = [];
  const selectedSpeaking =
    selected != null && speaking.some((s) => s.name === selected);

  if (selectedSpeaking) {
    kept.push(selected as string);
  }

  for (const s of byRecency) {
    if (kept.length >= limit) break;
    if (s.name === selected && selectedSpeaking) continue; // already added first
    kept.push(s.name);
  }

  return kept;
}
