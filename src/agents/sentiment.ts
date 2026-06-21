/**
 * Phase C · Slice C1 — warmth-only conversation sentiment (pure, deterministic).
 *
 * Scores the WARMTH of a finished conversation transcript with a static
 * positive-valence lexicon — NO LLM call, NO RNG, NO clock, NO I/O. The result
 * is a small non-negative BONUS added on top of the synchronous TALK_TO +2
 * floor (see Conversation._commit / Relationships.recordWarmth). There is NO
 * negative lexicon: a cold/curt/hostile chat simply scores 0 and stays +2.
 *
 * Purity contract (asserted by tests/agents/sentiment.test.ts):
 *  - same input ⇒ same output (no randomness, no clock reads anywhere);
 *  - neutral / curt mock variants ("Hmph. If you say so.", "Fine. Anything
 *    else?", "Good to hear, …") score EXACTLY 0 — the lexicon is curated to
 *    exclude the words that appear in the neutral/default/grumbling mock copy
 *    (notably the bare acknowledgement "good"), so the frozen "+2 after a
 *    4-turn convo" assertion holds untouched;
 *  - genuinely warm copy ("wondrous", "glad", "friend", "delight", "soon", …)
 *    scores, scaling with the warm-token count, clamped to WARMTH_BONUS_CAP.
 */
import type { ConversationTurn } from "@contracts/types";

/** Max warmth bonus added on top of the neutral TALK_TO floor (+2). 2 + 6 = +8
 *  total for a glowing exchange, matching the user-approved scale. */
export const WARMTH_BONUS_CAP = 6;

/**
 * Curated POSITIVE-valence lexicon (lowercased, matched as whole-word tokens).
 *
 * Warm-specific ON PURPOSE. The existing neutral/curt mock variants must score
 * ZERO so the additive guarantee (a neutral chat is still exactly +2) holds:
 *  - grumbling: "Hmph. If you say so.", "Fine. Anything else?", "Right. Goodbye…"
 *  - default:   "Good to hear, …", "Is that so, …?", "Well, take care, …"
 *  - frugal:    "Mind the costs…", "A fair price is all I ask…"
 *  - reckless:  "Ha! Sure thing, let's do it!", "Why not — count me in!"
 *  - nervous:   "Oh — yes, of course…! I'll keep that in mind."
 *  - dreamy(neutral lines): "The fields hold many stories… I hear you…"
 *
 * Critically, the bare acknowledgement "good" (from the DEFAULT persona's
 * "Good to hear, …" reply, which appears in nearly every 4-turn convo whose A
 * is a plain farmer) is DELIBERATELY EXCLUDED — including it would push the
 * frozen grumbling "+2" assertion to +3. Warmth must come from genuinely warm
 * copy, not a neutral filler word.
 *
 * NO negative words — warmth-only policy.
 */
export const WARMTH_LEXICON: ReadonlySet<string> = new Set([
  "wonderful",
  "wondrous",
  "wonderous",
  "delight",
  "delightful",
  "glad",
  "happy",
  "joy",
  "joyful",
  "love",
  "dear",
  "friend",
  "friends",
  "kind",
  "kindly",
  "thanks",
  "thank",
  "welcome",
  "appreciate",
  "grateful",
  "cheer",
  "cheerful",
  "warm",
  "hope",
  "smile",
  "enjoy",
  "pleasure",
  "pleased",
  "blessing",
  "sweet",
  "soon",
]);

/**
 * Sum of positive-token occurrences across the WHOLE transcript, clamped to
 * [0, WARMTH_BONUS_CAP]. Pure + deterministic: lowercase each turn's text,
 * split on non-letters, count tokens that are in WARMTH_LEXICON. No randomness,
 * no clock reads. Occurrence-count (not distinct-token) is pinned — transcripts are ≤4
 * short utterances, so it is naturally bounded.
 */
export function warmthBonus(turns: ConversationTurn[]): number {
  if (!Array.isArray(turns) || turns.length === 0) return 0;
  let count = 0;
  for (const turn of turns) {
    const text = turn?.text;
    if (typeof text !== "string" || text.length === 0) continue;
    const tokens = text.toLowerCase().split(/[^a-z]+/);
    for (const tok of tokens) {
      if (tok && WARMTH_LEXICON.has(tok)) count += 1;
    }
  }
  return Math.min(WARMTH_BONUS_CAP, Math.max(0, count));
}
