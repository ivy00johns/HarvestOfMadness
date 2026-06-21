/**
 * Wave 4c (C2) — rumor distortion: INTENSIFY flavor.
 *
 * Pure, deterministic, claim-agnostic amplifier for relayed gossip. The gossip
 * relay (Cognition Wave 4b) carries a CANONICAL undistorted `claim` in memory
 * meta and propagates it unchanged across hops (like `origin`). The DISPLAYED
 * text is rendered as `wrapper + intensifyClaim(claim, hop)`. Because every
 * relay reads the canonical claim from meta (never the prior distorted text),
 * distortion cannot compound: it is re-derived from the canonical gist at each
 * hop and stays bounded by GOSSIP_MAX_HOPS (≤ 2 distortion steps: hop 2, hop 3).
 *
 * No Phaser, no LLM, no I/O, no RNG, no clock — same (claim, hop) in ⇒
 * same string out. Claim-agnostic: the amplifiers wrap the claim, they do NOT
 * parse or rewrite its content (no NLP), so they never produce nonsense on
 * arbitrary observation text.
 */

/**
 * Per-relay-hop intensifier ladder. Only hops 2..GOSSIP_MAX_HOPS ever apply
 * (hop 1 = first-hand, faithful). Each entry is `{ prefix, suffix }` wrapped
 * around the canonical claim. Hop 3 escalates VISIBLY beyond hop 2 (a stronger
 * collective-belief frame + a stronger trailing clause), reading as the rumor
 * "growing wilder" the further it travels — without touching the claim itself.
 */
export const RUMOR_INTENSIFIERS: Record<number, { prefix: string; suffix: string }> = {
  // hop-2 amplifier — the rumor is now hearsay making the rounds.
  2: { prefix: "word is, ", suffix: " — and folks are talking" },
  // hop-3 amplifier — escalated: collective certainty + an "all anyone talks
  // about" coda. Strictly stronger and longer than hop 2.
  3: { prefix: "the whole town swears ", suffix: " — it's all anyone can talk about" },
};

/** The highest hop the ladder defines an amplifier for (hops above clamp to it). */
const MAX_INTENSIFIER_HOP = Math.max(
  ...Object.keys(RUMOR_INTENSIFIERS).map((k) => Number(k)),
);

/**
 * Apply the hop-indexed intensifier to a CANONICAL claim.
 *
 * - `hop <= 1` → the claim is returned UNCHANGED (byte-identical first-hand;
 *   this is what keeps hop-1 gossip text identical to the legacy single-hop).
 * - `hop >= 2` → the claim is wrapped with `RUMOR_INTENSIFIERS[min(hop, max)]`
 *   (hops beyond the top of the ladder reuse the strongest amplifier — bounded).
 *
 * Pure + deterministic + claim-agnostic. Defensive on odd input: a non-finite
 * hop is treated as hop 1 (unchanged); an empty/whitespace claim is wrapped the
 * same way as any other string (the amplifier never throws and never parses
 * content). Idempotent per `(claim, hop)`.
 */
export function intensifyClaim(claim: string, hop: number): string {
  // Non-finite or sub-relay hops are faithful (no distortion).
  if (!Number.isFinite(hop) || hop <= 1) return claim;

  const tier = Math.min(Math.floor(hop), MAX_INTENSIFIER_HOP);
  const amp = RUMOR_INTENSIFIERS[tier];
  // Defensive: if the ladder has no entry for this tier, return unchanged.
  if (!amp) return claim;

  return `${amp.prefix}${claim}${amp.suffix}`;
}
