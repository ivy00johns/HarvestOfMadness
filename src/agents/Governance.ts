/**
 * Governance — Wave 4c: a town's "election". An agent proposes a shared rule of
 * conduct, it diffuses (like an event), agents vote, and a deadline + majority
 * tally adopts or rejects it.
 *
 * Pure, in-memory, never throws — mirrors EventBoard. Owned by CognitionSystem.
 * No framework deps, no global tick: resolveIfDue(now) is called lazily from the
 * cognition hot path (enrichObservation) + onDayAdvanced.
 *
 * INVARIANTS (load-bearing):
 *  - ONE active (open) proposal at a time. open() is a no-op when one is open.
 *  - The proposer is auto-aware + auto-yes the moment the proposal opens.
 *  - The deadline is the EVENING of openDay + 1 (closeDay/closePhase).
 *  - Termination is GUARANTEED by the dual rule (no deadlock possible):
 *      • EARLY adopt as soon as yes > awareCount / 2 (clear majority of knowers);
 *      • at the DEADLINE adopt iff yes > votedCount / 2 AND votedCount >= 2
 *        (min quorum 2 — a lone proposer can never auto-adopt), else REJECT.
 *  - Rules are FARMING/ECONOMY conduct, NEVER "gather at the tavern" (preserves
 *    the party kill-switch — only a seeded event pulls the town together).
 *  - composeRule is deterministic (hash(role + day)), no Math.random / Date.now.
 */
import type {
  NeedState,
  Phase,
  ProposalStatus,
  ProposalTally,
  TownProposal,
} from "@contracts/types";

/** Phase ordering for deadline comparison (mirrors Cognition.PHASE_INDEX). */
const PHASE_ORDER: Record<Phase, number> = {
  morning: 0,
  afternoon: 1,
  evening: 2,
  night: 3,
};

/** Minimum number of voters required for a deadline adopt (no lone-proposer auto-adopt). */
export const GOVERNANCE_QUORUM = 2;

/** djb2 — small deterministic string hash, always non-negative (mirrors mock.ts). */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Deterministic templated conduct rules, keyed by the proposer's dominant drive.
 * EVERY rule is about farming / economy / civic conduct — NONE is a gathering or
 * a tavern convergence (party kill-switch stays meaningful). hash(role+day)
 * picks the variant, like mockGoal/mockDailyPlan.
 */
const RULE_TEMPLATES: Record<string, string[]> = {
  wealth: [
    "agree a fair floor price so no one undersells the harvest at the shop",
    "pool our coin to keep seed stocks stocked for everyone in lean weeks",
  ],
  purpose: [
    "till and plant a shared common plot each morning before our own fields",
    "leave one plot fallow each season so the soil keeps its strength",
  ],
  energy: [
    "rest at home by nightfall so no one works themselves to exhaustion",
    "take turns at the well so the morning water never runs dry",
  ],
  social: [
    "always lend a hand watering a neighbour's thirsty crop when we pass it",
    "share spare seed with any farmer who has run short before the season ends",
  ],
  novelty: [
    "rotate which crop each of us plants so the town's harvest stays varied",
    "trial a new crop on one plot each season and share what we learn",
  ],
};

/** Fallback rule when the drive key is unknown (defensive). */
const FALLBACK_RULES = [
  "always lend a hand watering a neighbour's thirsty crop when we pass it",
  "agree a fair floor price so no one undersells the harvest at the shop",
];

export class Governance {
  /** All proposals ever opened (in-memory; cap is naturally tiny). */
  private readonly proposals = new Map<string, TownProposal>();
  /** Insertion order so current() picks the newest open proposal deterministically. */
  private readonly order: string[] = [];
  /** proposalId -> set of agent names aware of it (proposer included). */
  private readonly aware = new Map<string, Set<string>>();
  /** proposalId -> (agentName -> support). First vote sticks (idempotent). */
  private readonly votes = new Map<string, Map<string, boolean>>();

  /**
   * Open a proposal — ONLY when none is currently open. The proposer becomes
   * aware and auto-votes yes. Returns the stored proposal, or null when one is
   * already open (one-active invariant) or the id collides with an existing one.
   */
  open(proposal: TownProposal): TownProposal | null {
    if (this.hasOpen()) return null;
    if (this.proposals.has(proposal.id)) return null;
    const stored: TownProposal = { ...proposal, status: "open" };
    this.proposals.set(stored.id, stored);
    this.order.push(stored.id);
    // Proposer is auto-aware + auto-yes.
    this.markAware(stored.id, stored.proposer);
    this.vote(stored.id, stored.proposer, true);
    return stored;
  }

  /** Is there any open proposal right now? */
  hasOpen(): boolean {
    for (const id of this.order) {
      if (this.proposals.get(id)?.status === "open") return true;
    }
    return false;
  }

  /** The current open proposal (newest by insertion order), or null. */
  current(): TownProposal | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const p = this.proposals.get(this.order[i]);
      if (p && p.status === "open") return { ...p };
    }
    return null;
  }

  /** Get any proposal by id (defensive copy), or null. */
  get(id: string): TownProposal | null {
    const p = this.proposals.get(id);
    return p ? { ...p } : null;
  }

  /**
   * Mark an agent aware of a proposal. Returns true when this is NEW awareness
   * (the agent did not already know it), false otherwise. No-op for unknown ids.
   */
  markAware(id: string, name: string): boolean {
    if (!this.proposals.has(id)) return false;
    let set = this.aware.get(id);
    if (!set) {
      set = new Set<string>();
      this.aware.set(id, set);
    }
    const isNew = !set.has(name);
    set.add(name);
    return isNew;
  }

  /** Does the named agent know about this proposal? */
  isAware(id: string, name: string): boolean {
    return this.aware.get(id)?.has(name) ?? false;
  }

  /** How many agents are aware of this proposal (proposer included). */
  awareCount(id: string): number {
    return this.aware.get(id)?.size ?? 0;
  }

  /** Names aware of this proposal (fresh copy). */
  awareNames(id: string): string[] {
    return [...(this.aware.get(id) ?? new Set<string>())];
  }

  /**
   * Record a vote. The FIRST vote sticks — a later vote by the same agent is a
   * no-op (idempotent). Voting auto-marks the agent aware. Returns true when the
   * vote was newly recorded, false when the agent had already voted or the
   * proposal id is unknown / not open.
   */
  vote(id: string, name: string, support: boolean): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== "open") return false;
    this.markAware(id, name);
    let m = this.votes.get(id);
    if (!m) {
      m = new Map<string, boolean>();
      this.votes.set(id, m);
    }
    if (m.has(name)) return false; // first vote sticks
    m.set(name, support);
    return true;
  }

  /** Has the named agent voted on this proposal? */
  hasVoted(id: string, name: string): boolean {
    return this.votes.get(id)?.has(name) ?? false;
  }

  /** The agent's recorded stance, or undefined when they have not voted. */
  myVote(id: string, name: string): boolean | undefined {
    return this.votes.get(id)?.get(name);
  }

  /** Yes-count for a proposal. */
  yesCount(id: string): number {
    let n = 0;
    for (const v of this.votes.get(id)?.values() ?? []) if (v) n++;
    return n;
  }

  /** No-count for a proposal. */
  noCount(id: string): number {
    let n = 0;
    for (const v of this.votes.get(id)?.values() ?? []) if (!v) n++;
    return n;
  }

  /** Total number of votes cast (yes + no). */
  votedCount(id: string): number {
    return this.votes.get(id)?.size ?? 0;
  }

  /**
   * Lazy resolution (no global tick). Returns the transition outcome ONLY when
   * an open proposal actually flips to a terminal status on this call; otherwise
   * null (already terminal, no open proposal, or not yet due/decided).
   *
   * Dual termination rule — guarantees no deadlock:
   *   • EARLY adopt: yes > awareCount / 2 (a strict majority of all knowers).
   *   • At/after the DEADLINE (closeDay/closePhase evening of openDay+1):
   *       adopt iff yes > votedCount / 2 AND votedCount >= GOVERNANCE_QUORUM,
   *       else reject. The deadline branch ALWAYS produces a terminal status, so
   *       a proposal can never stay open forever.
   */
  resolveIfDue(now: { day: number; phase: Phase }): {
    id: string;
    adopted: boolean;
    tally: ProposalTally;
  } | null {
    const p = this.current();
    if (!p) return null;

    const yes = this.yesCount(p.id);
    const aware = this.awareCount(p.id);
    const voted = this.votedCount(p.id);

    // EARLY adopt — a clear majority of knowers, BUT never on a lone proposer:
    // the quorum guard (votedCount >= GOVERNANCE_QUORUM) is what stops a
    // single-agent proposal from auto-adopting itself before anyone else weighs
    // in. With the quorum met, yes > awareCount/2 lets a clear majority adopt
    // ahead of the deadline.
    if (voted >= GOVERNANCE_QUORUM && yes > aware / 2) {
      return this.finalize(p.id, true);
    }

    // DEADLINE check — at/after closeDay's closePhase, force a terminal status.
    const due =
      now.day > p.closeDay ||
      (now.day === p.closeDay &&
        PHASE_ORDER[now.phase] >= PHASE_ORDER[p.closePhase]);
    if (due) {
      const adopted = voted >= GOVERNANCE_QUORUM && yes > voted / 2;
      return this.finalize(p.id, adopted);
    }

    return null;
  }

  /** Flip a proposal's status to adopted/rejected and return the tally. */
  private finalize(id: string, adopted: boolean): {
    id: string;
    adopted: boolean;
    tally: ProposalTally;
  } | null {
    const p = this.proposals.get(id);
    if (!p || p.status !== "open") return null;
    p.status = adopted ? "adopted" : "rejected";
    return { id, adopted, tally: this.tallySnapshot(id)! };
  }

  /**
   * The adopted rule text — the only v1 "effect" (observable, NO economy
   * mutation). Returns the text of the most recently adopted proposal, or null.
   */
  activeNorm(): string | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const p = this.proposals.get(this.order[i]);
      if (p && p.status === "adopted") return p.ruleText;
    }
    return null;
  }

  /** Read-only tally snapshot for the HUD + VOTE-injection gate, or undefined. */
  tallySnapshot(id: string): ProposalTally | undefined {
    const p = this.proposals.get(id);
    if (!p) return undefined;
    const m = this.votes.get(id);
    const voterNames = m ? [...m.keys()] : [];
    return {
      id: p.id,
      proposer: p.proposer,
      ruleText: p.ruleText,
      status: p.status as ProposalStatus,
      yes: this.yesCount(id),
      no: this.noCount(id),
      awareCount: this.awareCount(id),
      votedCount: this.votedCount(id),
      voterNames,
    };
  }

  /**
   * Deterministic templated conduct rule from the proposer's role + dominant
   * drive + day. hash(role + day) picks the variant (like mockGoal). Reads role
   * DEFENSIVELY — works whether or not the roles system shipped. NEVER returns a
   * gathering/tavern rule (party kill-switch).
   */
  static composeRule(
    role: string | null | undefined,
    dominantDrive: keyof NeedState | string | null | undefined,
    day: number,
  ): string {
    const safeRole = typeof role === "string" && role.length > 0 ? role : "farmer";
    const drive =
      typeof dominantDrive === "string" && dominantDrive in RULE_TEMPLATES
        ? dominantDrive
        : "social";
    const variants = RULE_TEMPLATES[drive] ?? FALLBACK_RULES;
    const idx = hash(`${safeRole}:${day}`) % variants.length;
    return variants[idx];
  }
}
