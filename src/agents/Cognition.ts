/**
 * CognitionSystem — wires the generative-agents loop (memory stream ->
 * retrieval -> reflection -> planning -> relationships) into the v1 decision
 * pipeline. One instance per AgentManager.
 *
 * Hard rules honored here:
 * - rule 9 write discipline: every resolved action, heard utterance, gift
 *   (importance 7 both sides) and observed nearby activity (deduped per
 *   agent-pair-phase) becomes an `observation` memory;
 * - rule 10: nothing in here ever blocks or throws into the decision loop —
 *   all writes are fire-and-forget, retrieval is time-bounded;
 * - rule 11: reflection trigger is checked after each observation write;
 * - rule 12: ensurePlan() guarantees a DailyPlan exists BEFORE the first
 *   decision of the day (and onDayAdvanced() pre-warms plans);
 * - budget: importance is heuristic/hinted for routine memories (live
 *   fast-tier rating only for unclassifiable text); cognition LLM traffic is
 *   metered in `metrics`.
 *
 * Mode: mock unless VITE_MODEL_MODE=live (the exact check getRouter() uses).
 * Cognition prompts NEVER go through mockRouter — in mock mode the $0
 * deterministic helpers (rateImportanceMock/mockReflection/mockDailyPlan/
 * template summaries) are used directly.
 */
import type {
  AgentAction,
  EventBus,
  GameStamp,
  MemoryEntry,
  MemoryType,
  Observation,
  Router,
  SimEvent,
  Vec2,
  WorldApi,
} from "@contracts/types";
import { liveRouter } from "../llm/router";
import { getWorld } from "../world/instance";
import { getRenderApi } from "../world/render";
import type { Agent } from "./Agent";
import { chebyshev } from "./Observation";
import { getEventBus } from "./events";
import { InMemoryMemoryStore } from "./memory/MemoryStore";
import { rateImportance } from "./memory/importance";
import { ReflectionEngineImpl } from "./Reflection";
import { DiarySystem } from "./Diary";
import { PlannerImpl } from "./Planner";
import { RelationshipStoreImpl } from "./Relationships";
import { EventBoard } from "./EventBoard";
import type { ExecutorCognitionHooks } from "./ActionExecutor";
import { ConversationSystem } from "./Conversation";
import { NeedsSystem } from "./Needs";
import { GoalsSystem } from "./Goals";
import { RolesSystem } from "./Roles";
import { MortalitySystem } from "./Mortality";
import { Governance } from "./Governance";

/** Memory texts injected into prompts are truncated to this many chars. */
export const MEMORY_TEXT_MAX_CHARS = 200;
/** Retrieval query when the agent has no current plan step. */
export const DEFAULT_RETRIEVAL_QUERY = "what should I do now";
/** K for Smallville new_retrieve(focal=other) conversation topic grounding. */
export const CONVERSATION_RECALL_K = 3;
/** Importance pinned for gifts, both sides (spec rule 9). */
export const GIFT_IMPORTANCE = 7;

// ---------------------------------------------------------------------------
// Wave 4b — bounded multi-hop gossip (termination is non-negotiable)
// ---------------------------------------------------------------------------

/**
 * Hard hop ceiling — the load-bearing terminator. A gossip memory at
 * hop >= GOSSIP_MAX_HOPS is NEVER re-relayed, so the relay chain is at most
 * A(first-hand) → hop1 → hop2 → hop3 and then stops.
 */
export const GOSSIP_MAX_HOPS = 3;
/** Belief-decay factor applied to the source importance on each relay hop. */
export const GOSSIP_DECAY = 0.6;
/** Importance pinned for a hop-1 (first-hand) gossip listener memory. */
export const GOSSIP_BASE_IMPORTANCE = 4;
/** Decay backstop: a relay is suppressed once decayed importance drops below this. */
export const GOSSIP_MIN_RELAY_IMPORTANCE_FLOOR = 1;

/** Deterministic round-then-clamp into the [1,10] importance band. */
function clampRoundImportance(v: number): number {
  return Math.min(10, Math.max(1, Math.round(v)));
}

/** djb2 — deterministic non-negative string hash (mirrors mock.ts/Governance). */
function govHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Wave 4c — governance importance hints + the deterministic open-gate.
// ---------------------------------------------------------------------------

/** Importance of the proposer's own "I proposed a town rule" memory. */
export const GOVERNANCE_PROPOSE_IMPORTANCE = 8;
/** Importance of a "I heard about the proposed rule" memory (notice board / talk). */
export const GOVERNANCE_HEARD_IMPORTANCE = 7;
/** Importance of a relayed-via-talk "X told me about the proposed rule" memory. */
export const GOVERNANCE_DIFFUSE_IMPORTANCE = 6;
/** Importance of the adopted-norm memory written to every aware agent. */
export const GOVERNANCE_NORM_IMPORTANCE = 7;
/**
 * Open-gate divisor — a notice-board interaction opens a NEW proposal only when
 * `hash(name + day) % GOVERNANCE_OPEN_GATE_N === 0` (rare + replayable, no RNG),
 * AND no proposal is currently open. Tuned so a proposal opens occasionally over
 * a multi-day sim rather than on every board read.
 */
export const GOVERNANCE_OPEN_GATE_N = 4;

/**
 * Wave 4b — strip the gossip wrapper to recover the bounded core story, so the
 * relayed text does NOT grow across hops. Matches both the hop-1 legacy prefix
 * `"<Name> mentioned: "` and the hop>=2 provenance prefix
 * `"<Name> mentioned (heard from <Y>): "`. Returns the text unchanged when it
 * is not a gossip-wrapped memory.
 */
export function gossipCore(text: string): string {
  const m = /^[A-Za-z][^:]*? mentioned(?: \(heard from [^)]*\))?:\s*/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * Wave 4b — extract the prior teller name from a gossip-wrapped memory text.
 * For a hop-1 memory `"<Teller> mentioned: ..."` returns `<Teller>`; for a
 * hop>=2 memory `"<Relayer> mentioned (heard from <Origin>): ..."` returns
 * `<Relayer>` (the immediate prior teller). Returns null when not gossip text.
 */
export function gossipTeller(text: string): string | null {
  const m = /^([A-Za-z][^:]*?) mentioned(?: \(heard from [^)]*\))?:\s*/.exec(text);
  return m ? m[1] : null;
}

/** VITE_MODEL_MODE, read defensively (absent under plain node) — mirrors getRouter(). */
function detectModelMode(): string | undefined {
  return typeof import.meta !== "undefined" && import.meta.env
    ? (import.meta.env.VITE_MODEL_MODE as string | undefined)
    : undefined;
}

/**
 * Phase ordering for past-event filtering. morning < afternoon < evening < night.
 * Used by isPastEvent to decide whether an event is in the past relative to now.
 */
export const PHASE_INDEX: Record<import("@contracts/types").Phase, number> = {
  morning: 0,
  afternoon: 1,
  evening: 2,
  night: 3,
};

/**
 * Returns true when the event is strictly in the past relative to `now`.
 * "Past" = event.day < today, OR (event.day === today AND event.phase is
 * strictly before now.phase in morning < afternoon < evening < night order).
 * Events happening NOW (same day+phase) or in the future are NOT past.
 */
export function isPastEvent(
  event: { day: number; phase: import("@contracts/types").Phase },
  now: import("@contracts/types").GameStamp,
): boolean {
  if (event.day < now.day) return true;
  if (event.day > now.day) return false;
  // same day — compare phases
  return PHASE_INDEX[event.phase] < PHASE_INDEX[now.phase];
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface CognitionOpts {
  bus?: EventBus;
  /** live-router override for cognition calls (tests). NEVER mockRouter. */
  router?: Router;
  /** "live" enables LLM cognition; anything else = $0 mock helpers. */
  modelMode?: string;
  /** full live-gate override (tests) — wins over modelMode */
  live?: () => boolean;
  now?: () => GameStamp;
  world?: () => WorldApi;
  /** embedding fn override (tests) */
  embed?: (texts: string[]) => Promise<number[][]>;
}

export interface CognitionMetrics {
  planCalls: number;
  reflectionCalls: number;
  relationshipCalls: number;
  importanceCalls: number;
  /** Wave 3a — live smart-tier goal-synthesis calls (~1/agent/day). */
  goalCalls: number;
}

export class CognitionSystem implements ExecutorCognitionHooks {
  readonly memory: InMemoryMemoryStore;
  readonly reflection: ReflectionEngineImpl;
  /** Additive — end-of-day first-person journal entries (modeled on reflection). */
  readonly diary: DiarySystem;
  readonly planner: PlannerImpl;
  readonly relationships: RelationshipStoreImpl;
  /** v3 — seeded social events + knowledge diffusion (EventBoard). */
  readonly events = new EventBoard();
  /** Wave 4c — town governance: one active proposal, diffusion, voting, tally. */
  readonly governance = new Governance();
  /** live cognition LLM calls, by purpose (budget visibility) */
  readonly metrics: CognitionMetrics = {
    planCalls: 0,
    reflectionCalls: 0,
    relationshipCalls: 0,
    importanceCalls: 0,
    goalCalls: 0,
  };
  /** Wave 3a — intrinsic drives (PIANO keystone): event-sourced, no global tick. */
  readonly needs = new NeedsSystem();
  /** Wave 3a — needs-driven standing-goal synthesis (cached, cadence-gated). */
  readonly goals: GoalsSystem;
  /** Wave 4a — emergent role specialization (action-histogram, hysteresis-gated). */
  readonly roles = new RolesSystem();
  /**
   * Mortality (deterministic sim mechanic) — starvation / despair / murder.
   * Driven once per game-day in onDayAdvanced over the LIVING agents; pure +
   * conservative, so normally-behaving agents never die.
   */
  readonly mortality = new MortalitySystem();
  /** v3 — back-and-forth conversation reply generator */
  private conversation!: ConversationSystem;

  private readonly agents = new Map<string, Agent>();
  private readonly seenActivity = new Set<string>();
  private readonly heardSpeech = new Set<string>();
  /** v3 — tracks arrivals logged per agent+event to avoid duplicate feed events */
  private readonly arrivedAtEvent = new Set<string>();
  /**
   * Wave 4b — origin-dedup state: per agent, the set of story-origin ids that
   * agent already holds. A relay to listener L happens ONLY if L is not already
   * in knownOrigins[origin]; the write immediately marks L. This is the
   * absorbing storm guard that REPLACES the v3 single-hop hearsay block —
   * with N agents there are at most N−1 writes per origin (each agent learns an
   * origin at most once), so the relay process provably reaches a fixed point.
   */
  private readonly knownOrigins = new Map<string, Set<string>>();
  /**
   * Phase C · Slice 1 — memoized home→event A* path lengths, keyed by
   * `${homeKey}->${locationKey}`. Homes + the tavern are static, so A* runs at
   * most once per (home, location) pair (deterministic), not every decision.
   */
  private readonly homePathTilesCache = new Map<string, number | null>();

  private readonly bus: EventBus;
  private readonly router: Router;
  private readonly live: () => boolean;
  private readonly now: () => GameStamp;
  private readonly world: () => WorldApi;

  constructor(opts: CognitionOpts = {}) {
    this.bus = opts.bus ?? getEventBus();
    this.router = opts.router ?? liveRouter;
    this.live =
      opts.live ?? (() => (opts.modelMode ?? detectModelMode()) === "live");
    this.world = opts.world ?? getWorld;
    this.now = opts.now ?? (() => this.world().time());

    this.memory = new InMemoryMemoryStore({
      now: this.now,
      live: this.live,
      ...(opts.embed ? { embed: opts.embed } : {}),
    });

    this.reflection = new ReflectionEngineImpl({
      store: this.memory,
      write: (agentName, text, importance, sourceIds) =>
        this.write(agentName, "reflection", text, importance, sourceIds),
      bus: this.bus,
      live: this.live,
      router: this.router,
      now: this.now,
      onLiveCall: () => this.metrics.reflectionCalls++,
    });

    this.diary = new DiarySystem({
      store: this.memory,
      bus: this.bus,
      live: this.live,
      router: this.router,
      now: this.now,
    });

    this.planner = new PlannerImpl({
      bus: this.bus,
      live: this.live,
      router: this.router,
      now: this.now,
      landmarks: () => {
        try {
          return this.world().landmarks();
        } catch {
          return [];
        }
      },
      persona: (name) => this.personaOf(name),
      reflections: (name) =>
        this.memory
          .all(name)
          .filter((m) => m.type === "reflection")
          .map((m) => m.text),
      write: (agentName, text, importance) =>
        this.write(agentName, "plan", text, importance),
      onLiveCall: () => this.metrics.planCalls++,
      // Wave 3a — the synthesized standing goal (cache first, then the agent's
      // transient action.goal) feeds the plan prompt as an INPUT only.
      goalOf: (name) => this.goals.current(name) ?? this.agents.get(name)?.goal ?? null,
      // Wave 5b — derived role (cached sync read, then the agent's stored role)
      // routes a purposeful agent to its functional building in the mock plan.
      roleOf: (name) => this.roles.role(name) ?? this.agents.get(name)?.role ?? null,
    });

    this.goals = new GoalsSystem({
      live: this.live,
      router: this.router,
      now: this.now,
      persona: (name) => this.personaOf(name),
      needs: (name) => this.needs.state(name),
      topMemories: (name) => this.topMemoryTexts(name),
      onLiveCall: () => this.metrics.goalCalls++,
    });

    this.relationships = new RelationshipStoreImpl({
      bus: this.bus,
      live: this.live,
      router: this.router,
      now: this.now,
      persona: (name) => this.personaOf(name),
      onChange: (name) => this.refreshRelationshipRows(name),
      onLiveCall: () => this.metrics.relationshipCalls++,
    });

    this.conversation = new ConversationSystem({
      bus: this.bus,
      now: this.now,
      live: this.live,
      router: this.router,
      affinityText: (bName, aName) => {
        try {
          const rel = this.relationships.get(bName, aName);
          return rel?.summary ?? "";
        } catch {
          return "";
        }
      },
      writeMemory: (agentName, text, importance) => {
        // Pin the EXACT importance the ConversationSystem chose — do NOT re-rate
        // through the mock importance heuristic. The conversation summary is
        // written at SUMMARY_IMPORTANCE=4 to stay BELOW the gossip first-hand
        // gate (importance>=5, Cognition.ts:891); but rateImportanceMock would
        // bump any "Chatted with …" text to 5 (it matches "chat"), promoting the
        // summary into a gossip candidate and leaking it into gossip.test.ts.
        // The legacy pair already passes importance 5, so pinning is a no-op for
        // it (heuristic also yields 5) — only the summary's 4 is preserved.
        void this.write(agentName, "observation", text, importance).catch(() => {});
      },
      // Smallville new_retrieve(focal=other): the deterministic store retrieve
      // (proven by retrieval-determinism.test.ts) grounds reply topics in what
      // the responder knows/heard about the other agent. Small K. READ-only —
      // no new memories this slice. The store retrieve never throws into us, and
      // the ConversationSystem wraps this regardless.
      recall: (name, query) => this.memory.retrieve(name, query, CONVERSATION_RECALL_K),
      // Phase C · Slice C1 — apply a conversation-warmth affinity bonus on top of
      // the synchronous TALK_TO +2 floor. recordWarmth adjusts affinity only
      // (clamped, positive-only) without bumping talk/interaction/gift counters.
      applyWarmth: (a, b, bonus) =>
        this.relationships.recordWarmth(a, b, bonus, "a warm conversation"),
    });
  }

  /** Read-only snapshot of cognition LLM spend. Never mutates. */
  metricsSnapshot(): Readonly<CognitionMetrics> {
    return { ...this.metrics };
  }

  // -- agent registry --------------------------------------------------------

  registerAgent(agent: Agent): void {
    this.agents.set(agent.name, agent);
  }

  private personaOf(name: string): string {
    return this.agents.get(name)?.persona.description ?? "a farmer";
  }

  /** Top few memory texts (highest importance) for the goal prompt. Defensive. */
  private topMemoryTexts(name: string, k = 5): string[] {
    try {
      return this.memory
        .all(name)
        .slice()
        .sort((a, b) => b.importance - a.importance)
        .slice(0, k)
        .map((m) => truncateText(m.text, MEMORY_TEXT_MAX_CHARS));
    } catch {
      return [];
    }
  }

  /**
   * Phase C · Slice 1 — memoized home→location A* path length (tiles). Returns
   * `undefined` when no path exists (mock then defaults to attend). Static homes
   * + tavern ⇒ the cache is tiny and deterministic. Defensive: any throw ⇒
   * `undefined` (attendance gate stays additive).
   */
  private homePathTiles(home: Vec2, location: Vec2): number | undefined {
    const key = `${home.x},${home.y}->${location.x},${location.y}`;
    let cached = this.homePathTilesCache.get(key);
    if (cached === undefined && !this.homePathTilesCache.has(key)) {
      try {
        const path = this.world().findPath(home, location);
        cached = path ? path.length : null;
      } catch {
        cached = null;
      }
      this.homePathTilesCache.set(key, cached);
    }
    return cached === null || cached === undefined ? undefined : cached;
  }

  // -- v3 event seeding + diffusion ------------------------------------------

  /**
   * Seed a social event: the host knows it, gets a high-importance memory,
   * and the feed receives an event_seeded WorldEvent.
   */
  seedEvent(event: SimEvent): void {
    try {
      this.events.seed(event);
      void this.write(
        event.host,
        "observation",
        `I am hosting ${event.description} on day ${event.day} (${event.phase})`,
        8,
      ).catch(() => {});
      const t = this.now();
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "event_seeded",
        agentName: event.host,
        text: `${event.host} is planning ${event.description}`,
        payload: { eventId: event.id, host: event.host, description: event.description },
      });
    } catch {
      /* defensive — never throw into callers */
    }
  }

  // -- memory writing (rule 9 discipline) ------------------------------------

  /**
   * Append a memory: emits "memory_written", maintains the per-agent card
   * counters, and checks the reflection trigger after observation writes.
   * Never throws; resolves null on failure.
   */
  async write(
    agentName: string,
    type: MemoryType,
    text: string,
    importance: number,
    sourceIds?: string[],
    meta?: { origin?: string; hop?: number },
  ): Promise<MemoryEntry | null> {
    try {
      const clamped = Math.min(10, Math.max(1, Math.round(importance)));
      const entry = await this.memory.append({
        agentName,
        type,
        text: text.trim(),
        importance: clamped,
        createdAt: this.now(),
        ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
        // Wave 4b — additive gossip provenance; MemoryStore.append spreads
        // ...e so these flow through unchanged when present.
        ...(meta?.origin !== undefined ? { origin: meta.origin } : {}),
        ...(meta?.hop !== undefined ? { hop: meta.hop } : {}),
      });

      const agent = this.agents.get(agentName);
      if (agent) {
        agent.memoryCount = this.memory.all(agentName).length;
        if (type === "reflection") agent.reflectionCount += 1;
      }

      const t = this.now();
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "memory_written",
        agentName,
        text: `${agentName} remembers: ${truncateText(entry.text, 80)}`,
        payload: { memoryId: entry.id, type, importance: clamped },
      });

      // Rule 11: trigger check after each (observation) memory write.
      if (type === "observation") {
        void this.reflection.maybeReflect(agentName).catch(() => {});
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Wave 4b — has `agentName` already heard the story with this `origin`?
   * Used to suppress re-telling (origin-dedup, the absorbing storm guard).
   */
  private knowsOrigin(agentName: string, origin: string): boolean {
    return this.knownOrigins.get(agentName)?.has(origin) ?? false;
  }

  /** Wave 4b — record that `agentName` now holds the story with this `origin`. */
  private markOrigin(agentName: string, origin: string): void {
    let set = this.knownOrigins.get(agentName);
    if (!set) {
      set = new Set<string>();
      this.knownOrigins.set(agentName, set);
    }
    set.add(origin);
  }

  /** Heuristic-first importance, then hint, then (live only) fast-tier LLM. */
  private async importanceFor(text: string, hint?: number): Promise<number> {
    return rateImportance(text, hint, {
      live: this.live,
      router: this.router,
      onLiveCall: () => this.metrics.importanceCalls++,
    });
  }

  private writeObservation(agentName: string, text: string, hint?: number): void {
    void (async () => {
      const importance = await this.importanceFor(text, hint);
      await this.write(agentName, "observation", text, importance);
    })().catch(() => {});
  }

  /**
   * Rule 9: every resolved action becomes a memory for the actor.
   * GIVE_GIFT-ok is skipped here — onGift writes the richer both-sides pair.
   */
  recordOutcome(
    agent: Agent,
    action: AgentAction,
    result: { ok: boolean; reason?: string },
  ): void {
    // Wave 3a — refill intrinsic drives on the outcome (rule-10 try-wrapped,
    // runs even for GIVE_GIFT-ok so social drive is satisfied by gifting).
    try {
      this.needs.onOutcome(agent, action, result);
    } catch {
      /* defensive — needs bookkeeping must never block a decision */
    }
    // Wave 4a — histogram the (successful, role-bucketed) action toward the
    // emergent role. Runs BEFORE the GIVE_GIFT early-return so gifts count
    // toward the socialite bucket. Try-wrapped (rule 10).
    try {
      this.roles.onOutcome(agent, action, result);
    } catch {
      /* defensive — role bookkeeping must never block a decision */
    }
    if (action.action === "GIVE_GIFT" && result.ok) return;
    const text = outcomeText(action, result);
    const hint = result.ok
      ? OK_IMPORTANCE_HINTS[action.action] ?? 2
      : action.action === "HARVEST"
        ? 7 // rule 9: harvest-fail
        : 4;
    this.writeObservation(agent.name, text, hint);
  }

  /**
   * Rule 9: every utterance an agent hears (same/adjacent tile = earshot)
   * becomes a memory for the HEARER, deduped per speaker-hearer-phase-text.
   */
  recordSpeech(speaker: Agent, say: string, others: Agent[]): void {
    const t = this.now();
    for (const o of others) {
      if (o.name === speaker.name) continue;
      if (chebyshev(speaker.pos, o.pos) > 1) continue;
      const key = `${speaker.name}|${o.name}|${t.day}|${t.phase}|${say}`;
      if (this.heardSpeech.has(key)) continue;
      this.heardSpeech.add(key);
      this.writeObservation(o.name, `${speaker.name} said: "${say}"`, 5);
    }
  }

  /**
   * Cheap social awareness: on each decision, log what visible agents were
   * lastSeenDoing — deduped per agent-pair-phase to avoid flooding.
   */
  recordNearbyActivity(
    agent: Agent,
    visible: { name: string; lastSeenDoing: string }[],
  ): void {
    const t = this.now();
    for (const o of visible) {
      if (o.name === agent.name) continue;
      const key = `${agent.name}|${o.name}|${t.day}|${t.phase}`;
      if (this.seenActivity.has(key)) continue;
      this.seenActivity.add(key);
      this.writeObservation(agent.name, `I saw ${o.name} ${o.lastSeenDoing}`, 2);
    }
  }

  // -- executor hooks (ExecutorCognitionHooks) -------------------------------

  /**
   * v3 — Object interaction: write a memory for the actor and, for the
   * notice_board, teach the agent about any active seeded event they don't
   * yet know (passive information diffusion without conversation).
   */
  onUseObject(agent: Agent, objectId: string, objectKind: string): void {
    try {
      let memText: string;
      let importance: number;

      switch (objectKind) {
        case "well":
          memText = `I drew water at the well`;
          importance = 2;
          break;
        case "bench":
          memText = `I rested on the bench by the pond`;
          importance = 2;
          break;
        case "notice_board": {
          memText = `I read the town notice board`;
          importance = 3;
          // Passive event diffusion: teach the agent any active (non-past) event
          // they don't yet know. Mirrors the isPastEvent helper inline.
          try {
            const t = this.now();
            for (const event of this.events.all()) {
              if (isPastEvent(event, t)) continue;
              const isNew = this.events.markKnows(event.id, agent.name);
              if (isNew) {
                const announcement = `The town notice board announces: ${event.description} on day ${event.day} (${event.phase})`;
                void this.write(agent.name, "observation", announcement, 7).catch(() => {});
                this.bus.emit({
                  day: t.day,
                  phase: t.phase,
                  kind: "event_heard",
                  agentName: agent.name,
                  text: `${agent.name} read about ${event.description} on the notice board`,
                  payload: { eventId: event.id, from: "notice_board", to: agent.name },
                });
              }
            }
          } catch {
            /* defensive — diffusion must not interrupt the interaction */
          }
          // Wave 4c — governance rides the notice board (no PROPOSE ActionType):
          // open a new proposal (rare, hash-gated) or learn the open one.
          try {
            this.maybeOpenOrLearn(agent);
          } catch {
            /* defensive — governance must not interrupt the interaction */
          }
          break;
        }
        default:
          memText = `I used the ${objectKind} (${objectId})`;
          importance = 2;
      }

      this.writeObservation(agent.name, memText, importance);
    } catch {
      /* rule 10: never block a decision on cognition */
    }
  }

  // -- Wave 4c governance ----------------------------------------------------

  /**
   * Notice-board governance seam. With NO open proposal AND a deterministic gate
   * firing (`hash(name+day) % N === 0`, rare + replayable), the agent OPENS a new
   * proposal: composeRule from its role + dominant drive, emit `proposal_opened`,
   * write an importance-8 memory. Otherwise, if there is an open proposal the
   * agent does not yet know, it LEARNS it: markAware + importance-7 memory +
   * `proposal_heard`. Fire-and-forget; never throws.
   */
  private maybeOpenOrLearn(agent: Agent): void {
    const t = this.now();
    if (!this.governance.hasOpen()) {
      // Deterministic, rare open-gate — no RNG, replayable.
      if (govHash(`${agent.name}:${t.day}`) % GOVERNANCE_OPEN_GATE_N !== 0) return;
      let drive: string;
      try {
        drive = this.needs.dominant(agent.name);
      } catch {
        drive = "social";
      }
      const role = typeof agent.role === "string" ? agent.role : "farmer";
      const ruleText = Governance.composeRule(role, drive, t.day);
      const proposal = this.governance.open({
        id: `prop-${agent.name}-d${t.day}`,
        proposer: agent.name,
        ruleText,
        day: t.day,
        phase: t.phase,
        closeDay: t.day + 1,
        closePhase: "evening",
        status: "open",
      });
      if (!proposal) return; // a proposal opened concurrently — nothing to do
      void this.write(
        agent.name,
        "observation",
        `I proposed a town rule: ${ruleText}`,
        GOVERNANCE_PROPOSE_IMPORTANCE,
      ).catch(() => {});
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "proposal_opened",
        agentName: agent.name,
        text: `${agent.name} proposed a town rule: ${ruleText}`,
        payload: {
          proposalId: proposal.id,
          proposer: agent.name,
          ruleText,
        },
      });
      return;
    }

    // There is an open proposal — learn it if this agent doesn't know it yet.
    const open = this.governance.current();
    if (!open) return;
    const isNew = this.governance.markAware(open.id, agent.name);
    if (!isNew) return;
    void this.write(
      agent.name,
      "observation",
      `I read on the notice board a proposed town rule: ${open.ruleText}`,
      GOVERNANCE_HEARD_IMPORTANCE,
    ).catch(() => {});
    this.bus.emit({
      day: t.day,
      phase: t.phase,
      kind: "proposal_heard",
      agentName: agent.name,
      text: `${agent.name} read about the proposed rule on the notice board`,
      payload: { proposalId: open.id, from: "notice_board", to: agent.name },
    });
  }

  /**
   * Executor hook (ExecutorCognitionHooks.onVote). Records the agent's vote
   * (first vote sticks), writes an importance-4 memory, and lazily resolves the
   * tally. Voting an unknown/closed proposal is a silent no-op. Never throws.
   */
  onVote(agent: Agent, proposalId: string, support: boolean): void {
    try {
      const recorded = this.governance.vote(proposalId, agent.name, support);
      if (recorded) {
        const open = this.governance.get(proposalId);
        const ruleText = open?.ruleText ?? "the town rule";
        this.writeObservation(
          agent.name,
          `I voted ${support ? "for" : "against"} the proposed rule: ${ruleText}`,
          4,
        );
      }
      this.maybeResolve();
    } catch {
      /* rule 10: never block a decision on cognition */
    }
  }

  /**
   * Lazy tally resolution (no global tick). On a terminal transition emits
   * `proposal_resolved` and, on adopt, writes a norm memory to every aware
   * agent. Idempotent (resolveIfDue returns null after the first transition).
   * Fire-and-forget; never throws.
   */
  private maybeResolve(): void {
    try {
      const now = this.now();
      const r = this.governance.resolveIfDue(now);
      if (!r) return;
      this.bus.emit({
        day: now.day,
        phase: now.phase,
        kind: "proposal_resolved",
        text: `The town ${r.adopted ? "adopted" : "rejected"} the rule: ${r.tally.ruleText} (yes ${r.tally.yes}, no ${r.tally.no})`,
        payload: {
          proposalId: r.id,
          adopted: r.adopted,
          yes: r.tally.yes,
          no: r.tally.no,
          awareCount: r.tally.awareCount,
        },
      });
      if (r.adopted) {
        for (const name of this.governance.awareNames(r.id)) {
          void this.write(
            name,
            "observation",
            `The town adopted a new rule: ${r.tally.ruleText}`,
            GOVERNANCE_NORM_IMPORTANCE,
          ).catch(() => {});
        }
      }
    } catch {
      /* defensive — resolution must never throw into the decision loop */
    }
  }

  /** Gift resolved: high-importance memories + recordInteraction, BOTH sides. */
  onGift(giver: Agent, receiver: Agent, itemId: string): void {
    this.writeObservation(
      giver.name,
      `I gave ${receiver.name} 1 ${itemId} as a gift`,
      GIFT_IMPORTANCE,
    );
    this.writeObservation(
      receiver.name,
      `${giver.name} gave me 1 ${itemId} as a gift`,
      GIFT_IMPORTANCE,
    );
    this.relationships.recordInteraction(
      giver.name,
      receiver.name,
      "GIVE_GIFT",
      `I gave them 1 ${itemId}`,
    );
    this.relationships.recordInteraction(
      receiver.name,
      giver.name,
      "GIVE_GIFT",
      `they gave me 1 ${itemId}`,
    );
  }

  /** Conversation resolved: affinity both ways + the listener's memory + B's reply. */
  onTalk(speaker: Agent, listener: Agent, say: string | null): void {
    const topic = say ?? "a friendly chat";
    this.relationships.recordInteraction(speaker.name, listener.name, "TALK_TO", topic);
    this.relationships.recordInteraction(listener.name, speaker.name, "TALK_TO", topic);
    if (say === null) {
      // With a spoken line, recordSpeech already gave the listener a memory.
      this.writeObservation(
        listener.name,
        `${speaker.name} stopped to chat with me`,
        5,
      );
    }

    // v3 — generate B's reply (fire-and-forget; never blocks or throws).
    if (say !== null && say.trim() !== "") {
      try {
        this.conversation.handleReply(speaker, listener, say);
      } catch {
        /* defensive: reply generation must never interrupt the talk hook */
      }
    }

    // v3 — event diffusion: for each event the speaker knows that the listener
    // does not, mark the listener as knowing it and write a high-importance
    // observation memory. This is the one-hop cascade mechanism.
    try {
      const t = this.now();
      for (const event of this.events.knownBy(speaker.name)) {
        const isNew = this.events.markKnows(event.id, listener.name);
        if (isNew) {
          void this.write(
            listener.name,
            "observation",
            `${speaker.name} told me about ${event.description} on day ${event.day} (${event.phase}) at the tavern`,
            7,
          ).catch(() => {});
          this.bus.emit({
            day: t.day,
            phase: t.phase,
            kind: "event_heard",
            agentName: listener.name,
            text: `${speaker.name} invited ${listener.name} to ${event.description}`,
            payload: { eventId: event.id, from: speaker.name, to: listener.name },
          });
        }
      }
    } catch {
      /* defensive — event diffusion must never interrupt the talk hook */
    }

    // Wave 4b — bounded multi-hop gossip with origin tracking + belief decay.
    // The speaker shares their single most salient story (first-hand OR a held
    // relayable rumor) with the listener, UNLESS the listener already knows that
    // story's origin. Termination rests on two monotone bounds: (1) origin-dedup
    // is absorbing (a listener learns an origin at most once → ≤ N−1 writes per
    // origin); (2) the hard hop cap GOSSIP_MAX_HOPS=3 (a hop>=cap memory is never
    // re-relayed). Belief decay (importance × GOSSIP_DECAY^hop, floored at
    // GOSSIP_MIN_RELAY_IMPORTANCE_FLOOR) is for narrative fade, not termination —
    // at the default 4/0.6/floor-1 it bottoms out at 1 without crossing the floor,
    // so the hop cap is what stops a chain. No feedback loop: a relayed memory
    // carries the SAME origin, so re-sharing to any knower is suppressed.
    try {
      const speakerMems = this.memory.all(speaker.name);

      // Build relay candidates. A candidate exposes the SOURCE memory (for
      // salience + provenance), the propagated origin id, the listener's
      // out-hop, and the (possibly decayed) out-importance.
      type GossipCandidate = {
        source: MemoryEntry;
        origin: string;
        outHop: number;
        outImportance: number;
      };
      const candidates: GossipCandidate[] = [];
      for (const m of speakerMems) {
        if (m.type !== "observation") continue;
        if (m.origin === undefined) {
          // First-hand: the STRUCTURAL origin===undefined gate REPLACES the
          // deleted hearsay regex. Origin id = this source memory's own id
          // (deterministic — never a UUID). Hop-1 importance pinned to 4 and
          // the listener text stays byte-identical to the legacy single-hop.
          if (m.importance < 5) continue;
          candidates.push({
            source: m,
            origin: m.id,
            outHop: 1,
            outImportance: GOSSIP_BASE_IMPORTANCE,
          });
        } else {
          // Relay: only when the held memory is below the hop cap AND its
          // decayed importance still clears the floor. Origin propagates
          // unchanged; the out-hop strictly increases.
          if (m.hop === undefined || m.hop >= GOSSIP_MAX_HOPS) continue;
          const decayed = clampRoundImportance(m.importance * GOSSIP_DECAY);
          if (decayed < GOSSIP_MIN_RELAY_IMPORTANCE_FLOOR) continue;
          candidates.push({
            source: m,
            origin: m.origin,
            outHop: m.hop + 1,
            outImportance: decayed,
          });
        }
      }

      // Origin-dedup: never re-tell the listener a story they already hold.
      const tellable = candidates.filter(
        (c) => !this.knowsOrigin(listener.name, c.origin),
      );

      if (tellable.length > 0) {
        // Salience by SOURCE importance; ties broken by later-in-array (the
        // most recently appended), which keeps the frozen "treasure chest
        // imp 9" + first-hand-preference assertions green.
        let best = tellable[0];
        for (const c of tellable) {
          if (c.source.importance >= best.source.importance) best = c;
        }

        // Origin-dedup is absorbing: mark BOTH the speaker (who holds it) and
        // the listener (who now holds it) so neither re-receives this origin.
        this.markOrigin(speaker.name, best.origin);
        this.markOrigin(listener.name, best.origin);

        // gossipCore strips the wrapper so the relayed gist does NOT grow hop
        // over hop; truncate to the legacy 100-char bound.
        const gist = truncateText(gossipCore(best.source.text), 100);
        const text =
          best.outHop === 1
            ? `${speaker.name} mentioned: ${gist}` // BYTE-IDENTICAL legacy
            : `${speaker.name} mentioned (heard from ${
                gossipTeller(best.source.text) ?? speaker.name
              }): ${gist}`;

        void this.write(
          listener.name,
          "observation",
          text,
          best.outImportance,
          [best.source.id],
          { origin: best.origin, hop: best.outHop },
        ).catch(() => {});

        const t = this.now();
        this.bus.emit({
          day: t.day,
          phase: t.phase,
          kind: "gossip",
          agentName: speaker.name,
          text: `${speaker.name} told ${listener.name} the news`,
          payload: { origin: best.origin, hop: best.outHop },
        });
      }
    } catch {
      /* defensive — gossip must never throw into the decision loop */
    }

    // Wave 4c — governance diffusion: if the speaker knows the OPEN proposal and
    // the listener does not, the listener learns it (markAware + importance-6
    // memory + proposal_heard). Touches NO gossip/event sets — its own state and
    // its own try/catch, so it can never perturb event-diffusion or gossip.
    try {
      const open = this.governance.current();
      if (
        open &&
        this.governance.isAware(open.id, speaker.name) &&
        !this.governance.isAware(open.id, listener.name)
      ) {
        const isNew = this.governance.markAware(open.id, listener.name);
        if (isNew) {
          void this.write(
            listener.name,
            "observation",
            `${speaker.name} told me about the proposed town rule: ${open.ruleText}`,
            GOVERNANCE_DIFFUSE_IMPORTANCE,
          ).catch(() => {});
          const t = this.now();
          this.bus.emit({
            day: t.day,
            phase: t.phase,
            kind: "proposal_heard",
            agentName: listener.name,
            text: `${speaker.name} told ${listener.name} about the proposed rule`,
            payload: { proposalId: open.id, from: speaker.name, to: listener.name },
          });
        }
      }
    } catch {
      /* defensive — governance diffusion must never throw into the talk hook */
    }
  }

  // -- planning + observation enrichment -------------------------------------

  /** Rule 12: a DailyPlan exists before the first decision of the day. */
  async ensurePlan(agent: Agent): Promise<void> {
    try {
      await this.planner.planDay(agent.name, this.now().day);
    } catch {
      /* a plan failure must never stall a decision */
    }
  }

  /** Pre-warm every registered agent's plan (day_advanced / bootstrap). */
  onDayAdvanced(): void {
    // Wave 4c — a new day may cross a proposal's deadline; resolve lazily.
    this.maybeResolve();
    for (const agent of this.agents.values()) {
      // Mortality: the dead don't plan, dream, or journal. Skip them here so
      // the morning warm-up only touches the living (the scheduler skips them
      // too). Their card fields (alive/causeOfDeath/deathDay) stay surfaced.
      if (agent.alive === false) continue;
      // Wave 3a — morning cadence: recompute derive-on-read drives, apply the
      // daily regen pulse, force a goal refresh, THEN pre-warm the plan so the
      // synthesized goal lands as a plan INPUT. Each step is fire-and-forget
      // and try-wrapped; a failure degrades to the plain plan warm-up.
      try {
        this.needs.recomputeFromState(agent);
        this.needs.onDayAdvanced(agent.name);
      } catch {
        /* defensive */
      }
      // Wave 4a — once/game-day role derivation (synchronous, no LLM): apply
      // the hysteresis-gated update and cache the result on the agent.
      try {
        agent.role = this.roles.update(agent);
      } catch {
        /* defensive — role derivation must never block the morning warm-up */
      }
      void this.goals
        .refresh(agent.name, { force: true })
        .then((g) => {
          agent.goal = g;
        })
        .catch(() => {})
        .finally(() => {
          void this.ensurePlan(agent).catch(() => {});
        });
      // End-of-day journal: summarise the day that just ended from the memory
      // stream. Fire-and-forget AFTER the needs/goal/plan prewarm so it never
      // blocks the morning warm-up; guarded one-entry-per-agent-per-day inside.
      void this.diary.writeEntry(agent.name).catch(() => {});
    }

    // Mortality (deterministic): AFTER the per-agent prewarm, evaluate the
    // LIVING registered agents and resolve any deaths. Conservative thresholds
    // mean normally-behaving agents never die. Try-wrapped end to end so it can
    // never throw into the day-advance handler.
    this.evaluateMortality();
  }

  /**
   * Run the deterministic mortality pass over the LIVING agents and resolve any
   * deaths: flip alive/causeOfDeath/deathDay, emit a `death` feed event, and
   * best-effort mark the sprite (existing showSpeech only — no contract change;
   * the scheduler also stops scheduling the agent, so the sprite goes still).
   * Never throws.
   */
  private evaluateMortality(): void {
    try {
      const t = this.now();
      const living = [...this.agents.values()].filter((a) => a.alive !== false);
      const deaths = this.mortality.evaluate(living, t.day, (from, to) => {
        try {
          return this.relationships.get(from, to)?.affinity ?? null;
        } catch {
          return null;
        }
      });
      for (const d of deaths) {
        const agent = this.agents.get(d.name);
        if (!agent || agent.alive === false) continue;
        agent.alive = false;
        agent.causeOfDeath = d.cause;
        agent.deathDay = t.day;
        const text =
          d.cause === "murder" && d.by
            ? `💀 ${d.name} was murdered by ${d.by}`
            : `💀 ${d.name} died of ${d.cause}`;
        try {
          this.bus.emit({
            day: t.day,
            phase: t.phase,
            kind: "death",
            agentName: d.name,
            text,
            payload: {
              cause: d.cause,
              ...(d.by ? { by: d.by } : {}),
              day: t.day,
            },
          });
        } catch {
          /* a broken bus must never take the day-advance loop down */
        }
        // Best-effort sprite marker — existing RenderApi call only. The agent
        // is already unscheduled, so this is purely cosmetic. Headless-safe
        // (getRenderApi() is null with no scene).
        try {
          getRenderApi()?.showSpeech(d.name, "💀");
        } catch {
          /* render is best-effort and must never throw here */
        }
      }
    } catch {
      /* defensive — mortality must never throw into onDayAdvanced */
    }
  }

  /**
   * Decision-time enrichment: plan step + top-5 retrieved memories +
   * relationship rows onto the Observation (and the agent's card fields).
   * Defensive end to end — a cognition failure yields a v1-shaped obs.
   */
  async enrichObservation(obs: Observation, agent: Agent): Promise<void> {
    try {
      await this.ensurePlan(agent);
      const phase = this.now().phase;
      this.planner.advance(agent.name, phase);
      const step = this.planner.currentStep(agent.name, phase);
      obs.self.currentPlanStep = step?.goal ?? null;
      agent.planStep = step?.goal ?? null;

      const rels = this.relationships.topFor(agent.name, 5);
      if (rels.length > 0) {
        obs.self.relationships = rels.map((r) => ({
          name: r.otherName,
          affinity: r.affinity,
        }));
      }

      // Wave 3a — drives + standing goal. recomputeFromState refreshes the
      // derive-on-read energy/wealth drives; the vector rides the obs + card.
      // The goal refresh is fire-and-forget (cadence-gated; never blocks the
      // decision), and the cached goal is read synchronously so the prompt
      // always carries the freshest already-resolved goal. The transient LLM
      // action.goal still wins for its own turn.
      this.needs.recomputeFromState(agent);
      const need = this.needs.state(agent.name);
      obs.self.needs = need;
      agent.needs = need;
      void this.goals
        .refresh(agent.name)
        .then((g) => {
          agent.goal = g;
          obs.self.goal = g;
        })
        .catch(() => {});
      const cachedGoal = this.goals.current(agent.name);
      if (cachedGoal) obs.self.goal = cachedGoal;

      // Wave 4a — surface the CACHED role (synchronous, deterministic; the
      // hot path never re-derives — derivation happens once/game-day in
      // onDayAdvanced). Keeps obs.self.role + the agent's cached role in sync.
      const role = this.roles.role(agent.name);
      obs.self.role = role;
      agent.role = role;

      const query = step?.goal ?? DEFAULT_RETRIEVAL_QUERY;
      const memories = await this.memory.retrieve(agent.name, query);
      if (memories.length > 0) {
        obs.memories = memories.map((m) => ({
          text: truncateText(m.text, MEMORY_TEXT_MAX_CHARS),
          type: m.type,
          importance: m.importance,
        }));
      }

      this.recordNearbyActivity(agent, obs.nearby.agents);

      // v3 — surface known events (isNow = event day+phase matches current time)
      // Past events are excluded: only upcoming or currently-happening events are actionable.
      const t = this.now();
      const knownEvents = this.events
        .knownBy(agent.name)
        .filter((e) => !isPastEvent(e, t))
        .map((e) => {
          const isNow = e.day === t.day && e.phase === t.phase;
          if (!isNow) return { ...e, isNow };
          // Phase C · Slice 1 — attach the memoized home→event A* path length so
          // the mock attendance gate can weight by distance. Only isNow events
          // need it (mock reads it on nowEvent); omit when unreachable.
          const homePathTiles = this.homePathTiles(agent.home, e.location);
          return homePathTiles === undefined
            ? { ...e, isNow }
            : { ...e, isNow, homePathTiles };
        });
      if (knownEvents.length > 0) {
        obs.self.knownEvents = knownEvents;
      }

      // v3 — arrival logging: for each known isNow event the agent is at/adjacent to
      try {
        for (const ke of knownEvents) {
          if (!ke.isNow) continue;
          if (chebyshev(agent.pos, ke.location) > 1) continue;
          const arrivalKey = `${agent.name}|${ke.id}`;
          if (this.arrivedAtEvent.has(arrivalKey)) continue;
          this.arrivedAtEvent.add(arrivalKey);
          void this.write(
            agent.name,
            "observation",
            `I arrived at ${ke.description}`,
            6,
          ).catch(() => {});
          this.bus.emit({
            day: t.day,
            phase: t.phase,
            kind: "event_arrived",
            agentName: agent.name,
            text: `${agent.name} arrived at ${ke.description}`,
            payload: { eventId: ke.id, agentName: agent.name },
          });
        }
      } catch {
        /* defensive — arrival logging must never interrupt enrichment */
      }

      // v3 — inviteTargets: for events this agent hosts that are NOT past, find agents who don't know yet
      try {
        const hostedEvents = this.events.all().filter((e) => e.host === agent.name && !isPastEvent(e, t));
        if (hostedEvents.length > 0) {
          const targets: { name: string; pos: { x: number; y: number } }[] = [];
          for (const e of hostedEvents) {
            for (const [, other] of this.agents) {
              if (other.name === agent.name) continue;
              if (this.events.knows(e.id, other.name)) continue;
              targets.push({ name: other.name, pos: { x: other.pos.x, y: other.pos.y } });
            }
          }
          if (targets.length > 0) {
            obs.self.inviteTargets = targets;
          }
        }
      } catch {
        /* defensive — inviteTargets must never interrupt enrichment */
      }

      // Wave 4c — governance surfacing + VOTE injection. Additive: only fires
      // when there is an OPEN proposal the agent is AWARE of, so frozen
      // mock-determinism scenes (no proposal) stay byte-identical. VOTE is
      // injected here (NOT in computeAvailableActions) only when the agent is
      // aware + has not yet voted.
      try {
        const open = this.governance.current();
        if (open && this.governance.isAware(open.id, agent.name)) {
          const vote = this.governance.myVote(open.id, agent.name);
          obs.self.activeProposal = {
            id: open.id,
            proposer: open.proposer,
            ruleText: open.ruleText,
            day: open.day,
            awareCount: this.governance.awareCount(open.id),
            yes: this.governance.yesCount(open.id),
            no: this.governance.noCount(open.id),
          };
          if (vote !== undefined) {
            obs.self.myVote = vote;
          } else if (!obs.availableActions.includes("VOTE")) {
            obs.availableActions = [...obs.availableActions, "VOTE"];
          }
        }
      } catch {
        /* defensive — governance surfacing must never interrupt enrichment */
      }

      // Wave 4c — lazy deadline/early-majority resolution on the hot path.
      this.maybeResolve();
    } catch {
      /* rule 10: never block/break a decision on cognition */
    }
  }

  // -- inspector feed ---------------------------------------------------------

  private refreshRelationshipRows(agentName: string): void {
    const agent = this.agents.get(agentName);
    if (!agent) return;
    agent.relationshipRows = this.relationships.topFor(agentName, 5).map((r) => ({
      name: r.otherName,
      affinity: r.affinity,
      summary: r.summary,
    }));
  }
}

/** Importance hints for OK action results (rule 9: routine farm action = 2). */
const OK_IMPORTANCE_HINTS: Partial<Record<AgentAction["action"], number>> = {
  TALK_TO: 5,
  WAIT: 1,
  EMOTE: 1,
  MOVE_TO: 2,
  TILL: 2,
  PLANT: 2,
  WATER: 2,
  HARVEST: 2,
  BUY: 2,
  SELL: 2,
  SLEEP: 2,
  USE_OBJECT: 3,
  VOTE: 4, // Wave 4c — a cast governance vote is a notable civic act
};

/** First-person memory text for a resolved action. */
export function outcomeText(
  action: AgentAction,
  result: { ok: boolean; reason?: string },
): string {
  const t = action.target as
    | {
        x?: number;
        y?: number;
        itemId?: string;
        qty?: number;
        agentName?: string;
        objectId?: string;
        proposalId?: string;
        support?: boolean;
      }
    | undefined;
  if (!result.ok) {
    return `I tried to ${action.action} but failed: ${result.reason ?? "unknown reason"}`;
  }
  switch (action.action) {
    case "MOVE_TO":
      return `I walked to (${t?.x},${t?.y})`;
    case "TILL":
      return `I tilled the ground at (${t?.x},${t?.y})`;
    case "PLANT":
      return `I planted a seed at (${t?.x},${t?.y})`;
    case "WATER":
      return `I watered the crop at (${t?.x},${t?.y})`;
    case "HARVEST":
      return `I harvested the crop at (${t?.x},${t?.y})`;
    case "BUY":
      return `I bought ${t?.qty}x ${t?.itemId} at the shop`;
    case "SELL":
      return `I sold ${t?.qty}x ${t?.itemId} at the shop`;
    case "TALK_TO":
      return `I talked with ${t?.agentName}${action.say ? ` — I said: "${action.say}"` : ""}`;
    case "GIVE_GIFT":
      return `I gave ${t?.agentName} 1 ${t?.itemId} as a gift`;
    case "EMOTE":
      return `I showed how I felt (${action.emotion ?? "neutral"})`;
    case "SLEEP":
      return "I slept through the night; a new day begins";
    case "USE_OBJECT":
      return `I used the ${t?.objectId ?? "object"}`;
    case "VOTE":
      return `I voted ${t?.support ? "for" : "against"} the town proposal`;
    case "WAIT":
    default:
      return "I waited for a while";
  }
}
