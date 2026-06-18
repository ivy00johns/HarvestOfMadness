/**
 * Wave 4c — pure builder for the live governance showcase strip.
 *
 * buildGovernancePanel(tally, townSize, maxNames=6) → GovernancePanelView:
 *   - tallyLine "Yes {yes} · No {no} · {awareCount}/{townSize} aware"
 *   - voterNames capped to maxNames
 *   - ruleText/proposer/status surfaced for chrome
 */
import { describe, expect, it } from "vitest";
import type { TownProposal } from "@contracts/types";
import { Governance } from "../../src/agents/Governance";
import { buildGovernancePanel } from "../../src/obs/GovernancePanel";

function openProposal(g: Governance): TownProposal {
  const p: TownProposal = {
    id: "prop-1",
    proposer: "Alice",
    ruleText: "always lend a hand watering a neighbour's thirsty crop when we pass it",
    day: 1,
    phase: "morning",
    closeDay: 2,
    closePhase: "evening",
    status: "open",
  };
  g.open(p);
  return p;
}

describe("buildGovernancePanel", () => {
  it("tallyLine reflects yes / no / aware over the town size", () => {
    const g = new Governance();
    openProposal(g); // Alice aware + yes
    g.vote("prop-1", "Bob", true); // yes 2
    g.vote("prop-1", "Carol", false); // no 1, aware 3
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 12);
    expect(view.tallyLine).toBe("Yes 2 · No 1 · 3/12 aware");
    expect(view.yes).toBe(2);
    expect(view.no).toBe(1);
    expect(view.awareCount).toBe(3);
  });

  it("surfaces ruleText, proposer, and status for the chrome", () => {
    const g = new Governance();
    const p = openProposal(g);
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 6);
    expect(view.ruleText).toBe(p.ruleText);
    expect(view.proposer).toBe("Alice");
    expect(view.status).toBe("open");
  });

  it("voter names are capped to maxNames (default 6)", () => {
    const g = new Governance();
    openProposal(g);
    for (let i = 0; i < 20; i++) g.vote("prop-1", `Voter${i}`, true);
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 24);
    expect(view.voterNames.length).toBeLessThanOrEqual(6);
  });

  it("respects an explicit maxNames argument", () => {
    const g = new Governance();
    openProposal(g);
    for (let i = 0; i < 10; i++) g.vote("prop-1", `Voter${i}`, true);
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 24, 3);
    expect(view.voterNames.length).toBeLessThanOrEqual(3);
  });

  it("reflects a terminal status once the proposal resolves", () => {
    const g = new Governance();
    openProposal(g);
    g.vote("prop-1", "Bob", true); // aware 2, yes 2 > 2/2 = 1, voted 2 >= quorum → adopt
    g.resolveIfDue({ day: 1, phase: "morning" });
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 6);
    expect(view.status).toBe("adopted");
  });

  it("never throws on a zero/empty town", () => {
    const g = new Governance();
    openProposal(g);
    const view = buildGovernancePanel(g.tallySnapshot("prop-1")!, 0);
    expect(view.tallyLine).toBe("Yes 1 · No 0 · 1/0 aware");
  });
});
