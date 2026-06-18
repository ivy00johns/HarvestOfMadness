/**
 * Wave 4c — Governance lifecycle proof (mirrors the party-emergence harness).
 *
 * Real World + TimeSystem + CognitionSystem (mock mode), real buildObservation +
 * enrichObservation + mockRouter + executeAction via runDecisionCycle with
 * msPerTile:0 (instant walk — we test the civic seam, not physics). Time is
 * advanced manually so we control exactly when each phase starts.
 *
 * WHAT THIS PROVES:
 *  - A proposal opened via the notice-board seam DIFFUSES through agent talk.
 *  - Aware, unvoted agents cast a VOTE (injected by enrichObservation) — ≥2.
 *  - The tally reaches a TERMINAL status (adopted/rejected) — the deadline
 *    guarantees no deadlock.
 *  - The feed narrates proposal_opened + proposal_heard + proposal_resolved.
 *  - The whole run is DETERMINISTIC (two passes produce the same outcome).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorldEvent } from "@contracts/types";
import { getWorld, getTimeSystem, resetWorldForTests } from "../../src/world/instance";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";
import { Agent } from "../../src/agents/Agent";
import { PERSONAS } from "../../src/agents/personas";
import { CognitionSystem, GOVERNANCE_OPEN_GATE_N } from "../../src/agents/Cognition";
import { Governance } from "../../src/agents/Governance";
import { runDecisionCycle } from "../../src/agents/AgentRuntime";
import { mockRouter } from "../../src/llm/mock";

/** djb2 — to find a notice-board open-gate firing day deterministically. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

interface SimResult {
  cognition: CognitionSystem;
  busEvents: WorldEvent[];
  agents: Agent[];
  proposalId: string | null;
}

/**
 * Run a full governance lifecycle sim.
 *
 * @param openViaSeam true = open through the real notice-board USE_OBJECT seam
 *   on a gate-firing day; false = open the proposal directly (deterministic
 *   id), used to exercise the diffuse→vote→resolve tail in isolation.
 */
async function runGovernanceSim(openViaSeam: boolean): Promise<SimResult> {
  const world = getWorld();
  const ts = getTimeSystem();
  const bus = getEventBus();

  const busEvents: WorldEvent[] = [];
  bus.on((e) => busEvents.push(e));

  // Use the first 4 real personas — enough for quorum + a clear majority.
  const agents = PERSONAS.slice(0, 4).map((p) => new Agent(p));

  const cognition = new CognitionSystem({
    bus,
    live: () => false,
    now: () => world.time(),
    world: () => world,
  });
  for (const agent of agents) cognition.registerAgent(agent);

  // Cluster all agents onto adjacent tiles so onTalk diffusion + voting fire
  // through the real decision cycle (no walking needed at msPerTile:0).
  const proposer = agents[0];
  agents.forEach((a, i) => {
    a.pos = { x: 10 + i, y: 18 }; // a clear open row; agents within talk range
  });

  let proposalId: string | null = null;

  if (openViaSeam) {
    // Find the day on which the proposer's open-gate fires, then advance the
    // clock there and open the proposal through the real notice-board seam.
    let gateDay = 1;
    while (hash(`${proposer.name}:${gateDay}`) % GOVERNANCE_OPEN_GATE_N !== 0) gateDay++;
    while (world.time().day < gateDay) ts.advanceDay();
    cognition.onUseObject(proposer, "notice_board", "notice_board");
    proposalId = cognition.governance.current()?.id ?? null;
  } else {
    const day = world.time().day;
    const rule = Governance.composeRule("farmer", "social", day);
    const opened = cognition.governance.open({
      id: `prop-${proposer.name}-d${day}`,
      proposer: proposer.name,
      ruleText: rule,
      day,
      phase: world.time().phase,
      closeDay: day + 1,
      closePhase: "evening",
      status: "open",
    });
    proposalId = opened?.id ?? null;
  }

  const execOpts = { msPerTile: 0, isPaused: () => false, speed: () => 1 };

  async function tickAll(): Promise<void> {
    for (const agent of agents) {
      await runDecisionCycle(agent, {
        world,
        agents,
        bus,
        router: mockRouter,
        cognition,
        executorOpts: execOpts,
      });
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  async function runPhase(ticks: number): Promise<void> {
    for (let t = 0; t < ticks; t++) await tickAll();
  }

  // The proposal opened on day = openDay. Run the open day fully (diffuse +
  // vote), then cross the deadline (openDay + 1 evening) to force resolution.
  const openDay = world.time().day;
  await runPhase(8); // open day morning — diffuse + early votes
  ts.step(); // → afternoon
  await runPhase(8);
  ts.step(); // → evening
  await runPhase(8);
  ts.step(); // → night
  ts.advanceDay(); // → openDay + 1, morning

  await runPhase(8); // openDay+1 morning
  ts.step(); // → afternoon
  await runPhase(8);
  ts.step(); // → evening (DEADLINE) — resolveIfDue forces a terminal status
  await runPhase(8);

  // Flush trailing fire-and-forget writes.
  for (let i = 0; i < 5; i++) await Promise.resolve();

  expect(world.time().day).toBe(openDay + 1);
  return { cognition, busEvents, agents, proposalId };
}

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
});
afterEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
});

describe("governance lifecycle", () => {
  it(
    "open via notice-board seam → diffuse → ≥2 votes → terminal status with full narration",
    async () => {
      const { cognition, busEvents, proposalId } = await runGovernanceSim(true);

      expect(proposalId, "the notice-board seam should have opened a proposal").not.toBeNull();
      const id = proposalId!;

      // -- 1. Diffusion: awareness grew beyond the lone proposer ---------------
      expect(
        cognition.governance.awareCount(id),
        "Expected diffusion to spread awareness beyond the proposer",
      ).toBeGreaterThanOrEqual(2);

      // -- 2. Voting: at least 2 distinct ballots were cast --------------------
      const snap = cognition.governance.tallySnapshot(id)!;
      expect(
        snap.votedCount,
        `Expected ≥ 2 votes (quorum), got ${snap.votedCount}: ${snap.voterNames.join(", ")}`,
      ).toBeGreaterThanOrEqual(2);

      // -- 3. Termination: a terminal status was reached (no deadlock) ---------
      const finalStatus = cognition.governance.get(id)!.status;
      expect(
        ["adopted", "rejected"].includes(finalStatus),
        `Expected a terminal status, got "${finalStatus}"`,
      ).toBe(true);
      expect(cognition.governance.hasOpen()).toBe(false);

      // -- 4. Feed narration ---------------------------------------------------
      expect(busEvents.some((e) => e.kind === "proposal_opened")).toBe(true);
      expect(
        busEvents.filter((e) => e.kind === "proposal_heard").length,
        "Expected ≥ 1 proposal_heard (diffusion narrated)",
      ).toBeGreaterThanOrEqual(1);
      expect(busEvents.some((e) => e.kind === "proposal_resolved")).toBe(true);

      // -- 5. On adopt, activeNorm reflects the rule ---------------------------
      if (finalStatus === "adopted") {
        expect(cognition.governance.activeNorm()).toBe(snap.ruleText);
      } else {
        expect(cognition.governance.activeNorm()).toBeNull();
      }
    },
    120_000,
  );

  it(
    "directly-opened proposal also diffuses, votes, and reaches a terminal status",
    async () => {
      const { cognition, busEvents, proposalId } = await runGovernanceSim(false);
      const id = proposalId!;
      const snap = cognition.governance.tallySnapshot(id)!;
      expect(snap.votedCount).toBeGreaterThanOrEqual(2);
      expect(["adopted", "rejected"]).toContain(cognition.governance.get(id)!.status);
      expect(busEvents.some((e) => e.kind === "proposal_resolved")).toBe(true);
    },
    120_000,
  );

  it(
    "the full lifecycle is DETERMINISTIC across two independent passes",
    async () => {
      const summarize = async (): Promise<string> => {
        resetWorldForTests();
        resetEventBusForTests();
        const { cognition, proposalId } = await runGovernanceSim(true);
        const id = proposalId!;
        const snap = cognition.governance.tallySnapshot(id)!;
        return JSON.stringify({
          id,
          status: cognition.governance.get(id)!.status,
          yes: snap.yes,
          no: snap.no,
          aware: snap.awareCount,
          voters: snap.voterNames.slice().sort(),
        });
      };
      const a = await summarize();
      const b = await summarize();
      expect(a).toBe(b);
    },
    120_000,
  );
});
