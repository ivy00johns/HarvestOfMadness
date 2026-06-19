/**
 * Wave 4c — Governance v1 (propose + vote on a town rule).
 *
 * Mirrors the event-diffusion harness: no LLM calls, no server — $0 mock mode.
 *
 * Coverage:
 *  - Governance unit: open-once (one active proposal), proposer auto-aware +
 *    auto-yes, vote idempotent, markAware, composeRule deterministic + never a
 *    tavern rule, dual-rule resolveIfDue (early majority / deadline / quorum).
 *  - Propose seam: USE_OBJECT on the notice_board opens a proposal when the gate
 *    fires (emits proposal_opened, imp-8 memory).
 *  - Diffuse: onTalk knower→non-knower marks aware + imp-6 memory +
 *    proposal_heard; non-knower→non-knower nothing; idempotent.
 *  - Deterministic mock vote.
 *  - Tally adopt (early majority → proposal_resolved adopted:true, activeNorm set);
 *    reject on no-quorum (lone proposer at deadline); reject on no-majority.
 *  - Observation surfacing (activeProposal + VOTE injected when aware+unvoted;
 *    myVote after voting).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ActionType,
  EventBus,
  GameStamp,
  Observation,
  TownProposal,
  Vec2,
  WorldEvent,
} from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { Governance, GOVERNANCE_QUORUM } from "../../src/agents/Governance";
import {
  CognitionSystem,
  GOVERNANCE_OPEN_GATE_N,
} from "../../src/agents/Cognition";
import { buildUserPrompt } from "../../src/llm/prompts";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeStampBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => {
      events.push({ ...e, seq: ++seq, ts: Date.now() });
    },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

function makeAgent(name: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  return new Agent({
    id: name.toLowerCase(),
    name,
    description: `${name} — test agent`,
    color: 0xffffff,
    start: pos,
  });
}

function makeProposal(overrides: Partial<TownProposal> = {}): TownProposal {
  return {
    id: "prop-1",
    proposer: "Alice",
    ruleText: "always lend a hand watering a neighbour's thirsty crop when we pass it",
    day: 1,
    phase: "morning",
    closeDay: 2,
    closePhase: "evening",
    status: "open",
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Governance unit
// ---------------------------------------------------------------------------

describe("Governance unit", () => {
  it("open() makes the proposer aware and auto-votes yes", () => {
    const g = new Governance();
    const p = g.open(makeProposal());
    expect(p).not.toBeNull();
    expect(g.isAware("prop-1", "Alice")).toBe(true);
    expect(g.myVote("prop-1", "Alice")).toBe(true);
    expect(g.yesCount("prop-1")).toBe(1);
    expect(g.votedCount("prop-1")).toBe(1);
  });

  it("open() refuses a second proposal while one is open (one active)", () => {
    const g = new Governance();
    expect(g.open(makeProposal({ id: "p1" }))).not.toBeNull();
    expect(g.hasOpen()).toBe(true);
    expect(g.open(makeProposal({ id: "p2", proposer: "Bob" }))).toBeNull();
    expect(g.current()?.id).toBe("p1");
  });

  it("a new proposal can open once the prior one resolves", () => {
    const g = new Governance();
    g.open(makeProposal({ id: "p1", proposer: "Alice", closeDay: 2 }));
    // A lone proposer can NOT early-adopt (quorum guard). It rejects at the
    // deadline for lack of quorum.
    const r = g.resolveIfDue({ day: 2, phase: "evening" });
    expect(r?.adopted).toBe(false);
    expect(g.hasOpen()).toBe(false);
    // Now a fresh proposal may open.
    expect(g.open(makeProposal({ id: "p2", proposer: "Bob" }))).not.toBeNull();
    expect(g.current()?.id).toBe("p2");
  });

  it("markAware returns true the first time, false on repeat", () => {
    const g = new Governance();
    g.open(makeProposal());
    expect(g.markAware("prop-1", "Bob")).toBe(true);
    expect(g.markAware("prop-1", "Bob")).toBe(false);
    expect(g.awareCount("prop-1")).toBe(2); // Alice (proposer) + Bob
  });

  it("vote is idempotent — the first vote sticks", () => {
    const g = new Governance();
    g.open(makeProposal());
    expect(g.vote("prop-1", "Bob", true)).toBe(true);
    expect(g.vote("prop-1", "Bob", false)).toBe(false); // second vote ignored
    expect(g.myVote("prop-1", "Bob")).toBe(true);
    expect(g.votedCount("prop-1")).toBe(2); // Alice + Bob
  });

  it("voting auto-marks the agent aware", () => {
    const g = new Governance();
    g.open(makeProposal());
    expect(g.isAware("prop-1", "Carol")).toBe(false);
    g.vote("prop-1", "Carol", false);
    expect(g.isAware("prop-1", "Carol")).toBe(true);
  });

  it("votes on an unknown/closed proposal are no-ops", () => {
    const g = new Governance();
    expect(g.vote("nope", "Bob", true)).toBe(false);
    g.open(makeProposal({ closeDay: 2 }));
    g.resolveIfDue({ day: 2, phase: "evening" }); // rejects at the deadline (no quorum)
    expect(g.hasOpen()).toBe(false);
    expect(g.vote("prop-1", "Bob", true)).toBe(false); // closed now
  });

  it("composeRule is deterministic for the same (role, drive, day)", () => {
    const a = Governance.composeRule("farmer", "social", 3);
    const b = Governance.composeRule("farmer", "social", 3);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("composeRule NEVER yields a tavern / gathering rule (party kill-switch)", () => {
    for (const role of ["farmer", "merchant", "socialite", "wanderer", "banker"]) {
      for (const drive of ["energy", "wealth", "social", "novelty", "purpose", "bogus"]) {
        for (let day = 1; day <= 12; day++) {
          const rule = Governance.composeRule(role, drive, day).toLowerCase();
          expect(rule, `${role}/${drive}/${day}`).not.toContain("tavern");
          expect(rule, `${role}/${drive}/${day}`).not.toContain("gather");
          expect(rule, `${role}/${drive}/${day}`).not.toContain("party");
        }
      }
    }
  });

  it("composeRule reads role/drive defensively (null/undefined safe)", () => {
    expect(Governance.composeRule(null, null, 1).length).toBeGreaterThan(0);
    expect(Governance.composeRule(undefined, undefined, 1).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveIfDue — the dual termination rule
// ---------------------------------------------------------------------------

describe("Governance.resolveIfDue (dual termination)", () => {
  it("EARLY adopt: yes > awareCount / 2 before the deadline", () => {
    const g = new Governance();
    g.open(makeProposal()); // Alice aware + yes
    g.markAware("prop-1", "Bob");
    g.markAware("prop-1", "Carol"); // aware = 3 (Alice, Bob, Carol)
    g.vote("prop-1", "Bob", true); // yes = 2 > 3/2 = 1.5 → early adopt
    const r = g.resolveIfDue({ day: 1, phase: "morning" });
    expect(r).not.toBeNull();
    expect(r!.adopted).toBe(true);
    expect(g.activeNorm()).toBe(g.get("prop-1")!.ruleText);
    // Idempotent: a second resolve is a no-op (already terminal).
    expect(g.resolveIfDue({ day: 1, phase: "morning" })).toBeNull();
  });

  it("no early adopt while yes is only half of awareCount", () => {
    const g = new Governance();
    g.open(makeProposal()); // Alice yes
    g.markAware("prop-1", "Bob");
    g.markAware("prop-1", "Carol");
    g.markAware("prop-1", "Dave"); // aware = 4, yes = 1 → 1 > 2 is false
    expect(g.resolveIfDue({ day: 1, phase: "afternoon" })).toBeNull();
    expect(g.hasOpen()).toBe(true);
  });

  it("DEADLINE reject on NO quorum (lone proposer never auto-adopts)", () => {
    const g = new Governance();
    g.open(makeProposal()); // Alice yes only → votedCount 1 < quorum 2
    expect(GOVERNANCE_QUORUM).toBe(2);
    // Not yet due — stays open.
    expect(g.resolveIfDue({ day: 2, phase: "morning" })).toBeNull();
    // Deadline (day 2 evening) — forced terminal; rejected for lack of quorum.
    const r = g.resolveIfDue({ day: 2, phase: "evening" });
    expect(r).not.toBeNull();
    expect(r!.adopted).toBe(false);
    expect(g.get("prop-1")!.status).toBe("rejected");
    expect(g.activeNorm()).toBeNull();
  });

  it("DEADLINE reject on NO majority (quorum met, yes not > voted/2)", () => {
    const g = new Governance();
    g.open(makeProposal()); // Alice yes
    g.markAware("prop-1", "Bob");
    g.markAware("prop-1", "Carol");
    g.markAware("prop-1", "Dave");
    g.markAware("prop-1", "Eve"); // aware = 5 (so no early adopt at yes 1)
    g.vote("prop-1", "Bob", false);
    g.vote("prop-1", "Carol", false); // yes 1, no 2, voted 3 → 1 > 1.5 false
    const r = g.resolveIfDue({ day: 2, phase: "evening" });
    expect(r).not.toBeNull();
    expect(r!.adopted).toBe(false);
    expect(g.get("prop-1")!.status).toBe("rejected");
  });

  it("DEADLINE adopt when quorum met AND yes is a strict majority", () => {
    const g = new Governance();
    g.open(makeProposal()); // Alice yes
    g.markAware("prop-1", "Bob");
    g.markAware("prop-1", "Carol");
    g.markAware("prop-1", "Dave");
    g.markAware("prop-1", "Eve");
    g.markAware("prop-1", "Finn"); // aware 6 — keep early-adopt from firing at yes 2
    g.vote("prop-1", "Bob", true);
    g.vote("prop-1", "Carol", false); // yes 2, no 1, voted 3 → 2 > 1.5 true, but
    // aware = 6 so 2 > 3 is false (no early). Resolve only at the deadline.
    expect(g.resolveIfDue({ day: 1, phase: "evening" })).toBeNull();
    const r = g.resolveIfDue({ day: 2, phase: "evening" });
    expect(r!.adopted).toBe(true);
  });

  it("resolveIfDue returns null when there is no open proposal", () => {
    const g = new Governance();
    expect(g.resolveIfDue({ day: 9, phase: "night" })).toBeNull();
  });

  it("tallySnapshot reflects yes/no/aware/voted + voter names", () => {
    const g = new Governance();
    g.open(makeProposal());
    g.vote("prop-1", "Bob", true);
    g.vote("prop-1", "Carol", false);
    const snap = g.tallySnapshot("prop-1")!;
    expect(snap.yes).toBe(2); // Alice + Bob
    expect(snap.no).toBe(1); // Carol
    expect(snap.votedCount).toBe(3);
    expect(snap.awareCount).toBe(3);
    expect(snap.voterNames).toEqual(["Alice", "Bob", "Carol"]);
    expect(snap.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Propose seam — USE_OBJECT on the notice_board
// ---------------------------------------------------------------------------

describe("CognitionSystem propose seam (notice_board)", () => {
  let cog: CognitionSystem;
  let events: WorldEvent[];
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const made = makeStampBus();
    events = made.events;
    cog = new CognitionSystem({ bus: made.bus, live: () => false, now: () => now.stamp });
  });

  /** Find a (name, day) whose open-gate hash fires (deterministic search). */
  function findGateFiringDay(name: string): number {
    function hash(s: string): number {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
      return h >>> 0;
    }
    for (let day = 1; day <= 200; day++) {
      if (hash(`${name}:${day}`) % GOVERNANCE_OPEN_GATE_N === 0) return day;
    }
    throw new Error(`no gate-firing day found for ${name}`);
  }

  it("USE_OBJECT(notice_board) opens a proposal when the gate fires + emits proposal_opened + imp-8 memory", async () => {
    const alice = makeAgent("Alice");
    cog.registerAgent(alice);
    now.stamp = { day: findGateFiringDay("Alice"), phase: "morning" };

    expect(cog.governance.hasOpen()).toBe(false);
    cog.onUseObject(alice, "board-1", "notice_board");
    await flush();

    expect(cog.governance.hasOpen()).toBe(true);
    const open = cog.governance.current()!;
    expect(open.proposer).toBe("Alice");

    const opened = events.find((e) => e.kind === "proposal_opened");
    expect(opened).toBeDefined();
    expect(opened!.agentName).toBe("Alice");
    expect(opened!.payload?.proposalId).toBe(open.id);

    const mems = cog.memory.all("Alice");
    const proposeMem = mems.find((m) => m.text.includes("I proposed a town rule"));
    expect(proposeMem).toBeDefined();
    expect(proposeMem!.importance).toBe(8);
  });

  it("USE_OBJECT(notice_board) on a NON-firing day does NOT open a proposal", () => {
    const alice = makeAgent("Alice");
    cog.registerAgent(alice);
    // Pick a day where the gate does NOT fire.
    function hash(s: string): number {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
      return h >>> 0;
    }
    let nonFiring = 1;
    while (hash(`Alice:${nonFiring}`) % GOVERNANCE_OPEN_GATE_N === 0) nonFiring++;
    now.stamp = { day: nonFiring, phase: "morning" };
    cog.onUseObject(alice, "board-1", "notice_board");
    expect(cog.governance.hasOpen()).toBe(false);
  });

  it("a second reader LEARNS the open proposal via the board (markAware + proposal_heard + imp-7)", async () => {
    const alice = makeAgent("Alice");
    const bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    // Open a proposal directly (deterministic — bypasses the gate).
    now.stamp = { day: 1, phase: "morning" };
    cog.governance.open(makeProposal({ proposer: "Alice" }));

    expect(cog.governance.isAware("prop-1", "Bob")).toBe(false);
    cog.onUseObject(bob, "board-1", "notice_board");
    await flush();

    expect(cog.governance.isAware("prop-1", "Bob")).toBe(true);
    const heard = events.find(
      (e) => e.kind === "proposal_heard" && e.agentName === "Bob",
    );
    expect(heard).toBeDefined();
    expect(heard!.payload?.from).toBe("notice_board");

    const bobMems = cog.memory.all("Bob");
    const heardMem = bobMems.find((m) => m.text.includes("proposed town rule"));
    expect(heardMem).toBeDefined();
    expect(heardMem!.importance).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Diffusion — onTalk
// ---------------------------------------------------------------------------

describe("CognitionSystem governance diffusion (onTalk)", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let bob: Agent;
  let carol: Agent;
  let events: WorldEvent[];
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const made = makeStampBus();
    events = made.events;
    cog = new CognitionSystem({ bus: made.bus, live: () => false, now: () => now.stamp });
    alice = makeAgent("Alice", { x: 5, y: 5 });
    bob = makeAgent("Bob", { x: 5, y: 6 });
    carol = makeAgent("Carol", { x: 6, y: 5 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.registerAgent(carol);
    cog.governance.open(makeProposal({ proposer: "Alice" }));
  });

  it("a knower talking to a non-knower spreads it (markAware + imp-6 memory + proposal_heard)", async () => {
    expect(cog.governance.isAware("prop-1", "Bob")).toBe(false);
    cog.onTalk(alice, bob, "Morning, Bob.");
    expect(cog.governance.isAware("prop-1", "Bob")).toBe(true);

    await flush();
    const bobMems = cog.memory.all("Bob");
    const diffuseMem = bobMems.find(
      (m) =>
        m.text.includes("Alice told me about the proposed town rule"),
    );
    expect(diffuseMem).toBeDefined();
    expect(diffuseMem!.importance).toBe(6);

    const heard = events.find(
      (e) => e.kind === "proposal_heard" && e.agentName === "Bob",
    );
    expect(heard).toBeDefined();
    expect(heard!.payload?.from).toBe("Alice");
    expect(heard!.payload?.to).toBe("Bob");
  });

  it("a non-knower talking to a non-knower spreads NOTHING", () => {
    cog.onTalk(bob, carol, "Nice weather!");
    expect(cog.governance.isAware("prop-1", "Carol")).toBe(false);
  });

  it("re-telling an already-aware listener is idempotent (no second memory)", async () => {
    cog.onTalk(alice, bob, "Hey!");
    cog.onTalk(alice, bob, "Again!");
    await flush();
    // Anchor at the start: Phase C·S2 conversation topic-recall may QUOTE this
    // diffusion line inside a reply memory on the second onTalk. That echo is a
    // conversation memory, not a second diffusion memory — exactly ONE memory
    // STARTS with the diffusion preamble (the dedup invariant still holds).
    const diffuseMems = cog.memory
      .all("Bob")
      .filter((m) => m.text.startsWith("Alice told me about the proposed town rule"));
    expect(diffuseMems).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onVote hook
// ---------------------------------------------------------------------------

describe("CognitionSystem.onVote", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let bob: Agent;
  let events: WorldEvent[];
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const made = makeStampBus();
    events = made.events;
    cog = new CognitionSystem({ bus: made.bus, live: () => false, now: () => now.stamp });
    alice = makeAgent("Alice");
    bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
    cog.governance.open(makeProposal({ proposer: "Alice" }));
    cog.governance.markAware("prop-1", "Bob");
  });

  it("records the vote and writes an importance-4 memory", async () => {
    cog.onVote(bob, "prop-1", true);
    expect(cog.governance.myVote("prop-1", "Bob")).toBe(true);
    await flush();
    const mem = cog.memory
      .all("Bob")
      .find((m) => m.text.includes("I voted for the proposed rule"));
    expect(mem).toBeDefined();
    expect(mem!.importance).toBe(4);
  });

  it("a NO vote writes an 'against' memory", async () => {
    cog.onVote(bob, "prop-1", false);
    expect(cog.governance.myVote("prop-1", "Bob")).toBe(false);
    await flush();
    const mem = cog.memory
      .all("Bob")
      .find((m) => m.text.includes("I voted against the proposed rule"));
    expect(mem).toBeDefined();
  });

  it("an early-majority yes vote resolves the proposal and emits proposal_resolved adopted:true", async () => {
    // Alice (yes) + Bob aware → aware 2, Bob votes yes → yes 2 > 2/2 = 1 → adopt.
    cog.onVote(bob, "prop-1", true);
    await flush();
    const resolved = events.find((e) => e.kind === "proposal_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!.payload?.adopted).toBe(true);
    expect(cog.governance.activeNorm()).toBe(cog.governance.get("prop-1")!.ruleText);
    // Adopt writes a norm memory to every aware agent.
    const aliceNorm = cog.memory
      .all("Alice")
      .find((m) => m.text.includes("The town adopted a new rule"));
    expect(aliceNorm).toBeDefined();
    expect(aliceNorm!.importance).toBe(7);
  });

  it("voting an unknown proposal is a silent no-op (no crash, no memory)", async () => {
    cog.onVote(bob, "no-such-proposal", true);
    await flush();
    const mems = cog.memory.all("Bob").filter((m) => m.text.includes("voted"));
    expect(mems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Observation surfacing + VOTE injection
// ---------------------------------------------------------------------------

describe("CognitionSystem enrichObservation governance surfacing", () => {
  let cog: CognitionSystem;
  let alice: Agent;
  let bob: Agent;
  let now: { stamp: GameStamp };

  beforeEach(() => {
    resetWorldForTests();
    now = { stamp: { day: 1, phase: "morning" } };
    const made = makeStampBus();
    cog = new CognitionSystem({ bus: made.bus, live: () => false, now: () => now.stamp });
    alice = makeAgent("Alice");
    bob = makeAgent("Bob");
    cog.registerAgent(alice);
    cog.registerAgent(bob);
  });

  function makeObs(agent: Agent): Observation {
    return {
      self: {
        name: agent.name,
        persona: agent.persona.description,
        role: agent.role,
        pos: agent.pos,
        energy: agent.energy,
        gold: agent.gold,
        inventory: agent.inventory,
        goal: agent.goal,
      },
      time: now.stamp,
      nearby: { tiles: [], agents: [], landmarks: [] },
      lastAction: null,
      availableActions: ["WAIT"] as ActionType[],
      economy: { sells: {}, buys: {} },
    };
  }

  it("no proposal → activeProposal absent + VOTE not injected (byte-identical surface)", async () => {
    const obs = makeObs(alice);
    await cog.enrichObservation(obs, alice);
    expect(obs.self.activeProposal).toBeUndefined();
    expect(obs.self.myVote).toBeUndefined();
    expect(obs.availableActions).not.toContain("VOTE");
  });

  it("aware + unvoted → activeProposal surfaced + VOTE injected", async () => {
    cog.governance.open(makeProposal({ proposer: "Alice" }));
    cog.governance.markAware("prop-1", "Bob");
    const obs = makeObs(bob);
    await cog.enrichObservation(obs, bob);
    expect(obs.self.activeProposal).toBeDefined();
    expect(obs.self.activeProposal!.id).toBe("prop-1");
    expect(obs.self.activeProposal!.proposer).toBe("Alice");
    expect(obs.self.myVote).toBeUndefined();
    expect(obs.availableActions).toContain("VOTE");
  });

  it("aware but NOT yet aware → nothing surfaced (an unaware agent sees no proposal)", async () => {
    cog.governance.open(makeProposal({ proposer: "Alice" }));
    // Bob is NOT marked aware.
    const obs = makeObs(bob);
    await cog.enrichObservation(obs, bob);
    expect(obs.self.activeProposal).toBeUndefined();
    expect(obs.availableActions).not.toContain("VOTE");
  });

  it("after voting → myVote surfaced, VOTE no longer injected", async () => {
    cog.governance.open(makeProposal({ proposer: "Alice" }));
    cog.governance.markAware("prop-1", "Bob");
    cog.governance.vote("prop-1", "Bob", false);
    const obs = makeObs(bob);
    await cog.enrichObservation(obs, bob);
    expect(obs.self.myVote).toBe(false);
    expect(obs.availableActions).not.toContain("VOTE");
  });

  it("the proposer sees activeProposal + myVote:true (auto-yes), VOTE not injected", async () => {
    cog.governance.open(makeProposal({ proposer: "Alice" }));
    const obs = makeObs(alice);
    await cog.enrichObservation(obs, alice);
    expect(obs.self.activeProposal).toBeDefined();
    expect(obs.self.myVote).toBe(true);
    expect(obs.availableActions).not.toContain("VOTE");
  });
});

// ---------------------------------------------------------------------------
// Prompt gating — ACTIVE PROPOSAL section is byte-identical-absent
// ---------------------------------------------------------------------------

describe("buildUserPrompt governance gating", () => {
  function baseObs(): Observation {
    return {
      self: {
        name: "Bob",
        persona: "a farmer",
        role: "farmer",
        pos: { x: 1, y: 1 },
        energy: 100,
        gold: 200,
        inventory: [],
        goal: null,
      },
      time: { day: 1, phase: "morning" },
      nearby: { tiles: [], agents: [], landmarks: [] },
      lastAction: null,
      availableActions: ["WAIT"] as ActionType[],
      economy: { sells: {}, buys: {} },
    };
  }

  it("no activeProposal → byte-identical to the bare obs prompt", () => {
    const obs = baseObs();
    expect(buildUserPrompt(obs)).toBe(`${JSON.stringify(obs)}\nWhat do you do next?`);
  });

  it("with an unvoted proposal → an ACTIVE PROPOSAL section + a cast-vote hint", () => {
    const obs = baseObs();
    obs.availableActions = ["WAIT", "VOTE"];
    obs.self.activeProposal = {
      id: "prop-1",
      proposer: "Alice",
      ruleText: "share spare seed with any farmer who has run short",
      day: 1,
      awareCount: 3,
      yes: 2,
      no: 0,
    };
    const prompt = buildUserPrompt(obs);
    expect(prompt).toContain("ACTIVE PROPOSAL");
    expect(prompt).toContain("share spare seed");
    expect(prompt).toContain("2 yes / 0 no");
    expect(prompt).toContain("cast a VOTE");
  });

  it("the prompt prefix contains NO balanced JSON object (mock-parse safety)", () => {
    // A literal {...} in the prefix would steal extractFirstJsonObject from the
    // real observation JSON. The hint must therefore stay brace-free.
    const obs = baseObs();
    obs.availableActions = ["WAIT", "VOTE"];
    obs.self.activeProposal = {
      id: "prop-1",
      proposer: "Alice",
      ruleText: "rest at home by nightfall",
      day: 1,
      awareCount: 2,
      yes: 1,
      no: 0,
    };
    const prompt = buildUserPrompt(obs);
    const prefix = prompt.slice(0, prompt.indexOf(JSON.stringify(obs)));
    expect(prefix.includes("{")).toBe(false);
  });

  it("prefix stays brace-free when proposal-aware AND adjacent to a usable object (notice-board case)", () => {
    // The exact collision the notice board creates: an agent that just learned a
    // proposal is ALSO USE_OBJECT-adjacent, so both the ACTIVE PROPOSAL section
    // and the NEARBY OBJECTS hint render. Both must be brace-free or the mock's
    // extractFirstJsonObject grabs the hint instead of the observation -> WAIT.
    const obs = baseObs();
    obs.availableActions = ["WAIT", "VOTE", "USE_OBJECT"];
    obs.nearby.objects = [{ id: "notice_board", kind: "notice_board", pos: { x: 2, y: 1 } }];
    obs.self.activeProposal = {
      id: "prop-1",
      proposer: "Alice",
      ruleText: "rest at home by nightfall",
      day: 1,
      awareCount: 2,
      yes: 1,
      no: 0,
    };
    const prompt = buildUserPrompt(obs);
    const prefix = prompt.slice(0, prompt.indexOf(JSON.stringify(obs)));
    expect(prefix.includes("{")).toBe(false);
  });

  it("after voting → a 'you have already voted' line, no cast-vote hint", () => {
    const obs = baseObs();
    obs.self.activeProposal = {
      id: "prop-1",
      proposer: "Alice",
      ruleText: "leave one plot fallow each season",
      day: 1,
      awareCount: 4,
      yes: 2,
      no: 1,
    };
    obs.self.myVote = true;
    const prompt = buildUserPrompt(obs);
    expect(prompt).toContain("already voted YES");
    expect(prompt).not.toContain("cast a VOTE");
  });
});
