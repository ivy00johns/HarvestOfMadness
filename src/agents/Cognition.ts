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
  WorldApi,
} from "@contracts/types";
import { liveRouter } from "../llm/router";
import { getWorld } from "../world/instance";
import type { Agent } from "./Agent";
import { chebyshev } from "./Observation";
import { getEventBus } from "./events";
import { InMemoryMemoryStore } from "./memory/MemoryStore";
import { rateImportance } from "./memory/importance";
import { ReflectionEngineImpl } from "./Reflection";
import { PlannerImpl } from "./Planner";
import { RelationshipStoreImpl } from "./Relationships";
import { EventBoard } from "./EventBoard";
import type { ExecutorCognitionHooks } from "./ActionExecutor";
import { ConversationSystem } from "./Conversation";

/** Memory texts injected into prompts are truncated to this many chars. */
export const MEMORY_TEXT_MAX_CHARS = 200;
/** Retrieval query when the agent has no current plan step. */
export const DEFAULT_RETRIEVAL_QUERY = "what should I do now";
/** Importance pinned for gifts, both sides (spec rule 9). */
export const GIFT_IMPORTANCE = 7;

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
}

export class CognitionSystem implements ExecutorCognitionHooks {
  readonly memory: InMemoryMemoryStore;
  readonly reflection: ReflectionEngineImpl;
  readonly planner: PlannerImpl;
  readonly relationships: RelationshipStoreImpl;
  /** v3 — seeded social events + knowledge diffusion (EventBoard). */
  readonly events = new EventBoard();
  /** live cognition LLM calls, by purpose (budget visibility) */
  readonly metrics: CognitionMetrics = {
    planCalls: 0,
    reflectionCalls: 0,
    relationshipCalls: 0,
    importanceCalls: 0,
  };
  /** v3 — back-and-forth conversation reply generator */
  private conversation!: ConversationSystem;

  private readonly agents = new Map<string, Agent>();
  private readonly seenActivity = new Set<string>();
  private readonly heardSpeech = new Set<string>();
  /** v3 — tracks arrivals logged per agent+event to avoid duplicate feed events */
  private readonly arrivedAtEvent = new Set<string>();
  /** v3 — dedup for gossip sharing: "speakerName|listenerName|memId" */
  private readonly sharedGossip = new Set<string>();

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
        this.writeObservation(agentName, text, importance);
      },
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

    // v3 — gossip: speaker shares their single most salient first-person
    // observation with the listener (single-hop, first-hand only, deduped).
    try {
      // Hearsay-detection patterns: skip memories the speaker merely heard.
      const hearsayRe = /^[A-Za-z].* (?:mentioned:|told me|said:)/;
      const speakerMems = this.memory.all(speaker.name);
      // Consider only first-person observations with importance ≥ 5 that are
      // not themselves relayed hearsay.
      const candidates = speakerMems.filter(
        (m) =>
          m.type === "observation" &&
          m.importance >= 5 &&
          !hearsayRe.test(m.text),
      );
      if (candidates.length > 0) {
        // Pick highest importance; break ties by last in array (most recent append).
        let best = candidates[0];
        for (const m of candidates) {
          if (m.importance > best.importance) {
            best = m;
          } else if (m.importance === best.importance) {
            // Prefer the one that appears later in the array (more recent).
            best = m;
          }
        }
        const dedupKey = `${speaker.name}|${listener.name}|${best.id}`;
        if (!this.sharedGossip.has(dedupKey)) {
          this.sharedGossip.add(dedupKey);
          const gist = truncateText(best.text, 100);
          void this.write(
            listener.name,
            "observation",
            `${speaker.name} mentioned: ${gist}`,
            4,
          ).catch(() => {});
          const t = this.now();
          this.bus.emit({
            day: t.day,
            phase: t.phase,
            kind: "gossip",
            agentName: speaker.name,
            text: `${speaker.name} told ${listener.name} the news`,
          });
        }
      }
    } catch {
      /* defensive — gossip must never throw into the decision loop */
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
    for (const agent of this.agents.values()) {
      void this.ensurePlan(agent).catch(() => {});
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
        .map((e) => ({
          ...e,
          isNow: e.day === t.day && e.phase === t.phase,
        }));
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
};

/** First-person memory text for a resolved action. */
export function outcomeText(
  action: AgentAction,
  result: { ok: boolean; reason?: string },
): string {
  const t = action.target as
    | { x?: number; y?: number; itemId?: string; qty?: number; agentName?: string; objectId?: string }
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
    case "WAIT":
    default:
      return "I waited for a while";
  }
}
