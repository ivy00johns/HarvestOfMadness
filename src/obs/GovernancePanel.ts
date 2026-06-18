/**
 * GovernancePanel — pure builder for the live governance showcase strip
 * (Wave 4c). Mirrors PartyPanel: turns a ProposalTally (from Governance) plus
 * the town size into a flat, render-ready view that updates in place
 * ("Yes 3 · No 1 · 5/12 aware") rather than scrolling feed lines.
 *
 * Pure + defensive: no Phaser, never throws.
 */
import type { ProposalTally } from "@contracts/types";

export interface GovernancePanelView {
  ruleText: string;
  proposer: string;
  status: string;
  /** "Yes N · No M · K/townSize aware" */
  tallyLine: string;
  yes: number;
  no: number;
  awareCount: number;
  /** capped voter names for the chrome */
  voterNames: string[];
}

export function buildGovernancePanel(
  tally: ProposalTally,
  townSize: number,
  maxNames = 6,
): GovernancePanelView {
  const yes = Math.max(0, tally.yes);
  const no = Math.max(0, tally.no);
  const awareCount = Math.max(0, tally.awareCount);
  const town = Math.max(0, townSize);
  return {
    ruleText: tally.ruleText,
    proposer: tally.proposer,
    status: tally.status,
    tallyLine: `Yes ${yes} · No ${no} · ${awareCount}/${town} aware`,
    yes,
    no,
    awareCount,
    voterNames: tally.voterNames.slice(0, Math.max(0, maxNames)),
  };
}
