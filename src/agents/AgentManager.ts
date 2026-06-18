/**
 * AgentManager — THE async scheduler (mission §6, no global tick).
 *
 * Per-agent loop: IDLE -> (cooldown elapsed + not paused + global in-flight
 * < maxConcurrentDecisions) -> THINKING (router call, semaphore slot) ->
 * EXECUTING (multi-frame action) -> IDLE.
 *
 * Daily ceiling (domain rule 5, manager side): a manager-level counter of
 * LIVE-router decisions for the current UTC date — §6's MAX_DECISIONS_PER_DAY
 * is a COST kill-switch, so $0 mock decisions never count (whether mock by
 * VITE_MODEL_MODE, per-agent budget fallback, or the latch itself). Past
 * maxDecisionsPerDay ALL agents are routed via mockRouter and ONE
 * budget_reached event is emitted. The counter, per-agent decisionsToday,
 * and the ceiling latch reset on UTC date change.
 *
 * HUD API (consumed by obs-agent): pause/resume/step/setSpeed/agents/isPaused.
 */
import type { EventBus, Router, SchedulerConfig } from "@contracts/types";
import { SCHEDULER_DEFAULTS } from "@contracts/types";
import { getRouter, mockRouter } from "../llm/router";
import { getTimeSystem, getWorld } from "../world/instance";
import { getRenderApi } from "../world/render";
import type { Speed } from "../world/TimeSystem";
import { Agent, type Persona } from "./Agent";
import { PERSONAS } from "./personas";
import { getEventBus } from "./events";
import { runDecisionCycle } from "./AgentRuntime";
import { CognitionSystem } from "./Cognition";

/** Scheduler poll granularity (NOT the decision pace — that's the cooldown). */
const POLL_MS = 100;

// ---------------------------------------------------------------------------
// Recurring-gathering helpers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Should a new gathering be seeded on `day`?
 * Gatherings recur every 2 days, starting on day 2 (even days).
 */
export function shouldSeedGathering(day: number): boolean {
  return day >= 2 && day % 2 === 0;
}

/**
 * Build the SimEvent descriptor for a recurring tavern gathering on `day`.
 * Host is identified by name; location and description are always the same.
 */
export function buildGatheringEvent(
  day: number,
  hostName: string,
  tavernPos: { x: number; y: number },
): import("@contracts/types").SimEvent {
  return {
    id: `party-d${day}`,
    host: hostName,
    location: tavernPos,
    day,
    phase: "evening",
    description: "a gathering at the tavern",
  };
}

/**
 * §6 cooldown guidance: ~2500ms mock (SCHEDULER_DEFAULTS), ~6000ms+ live —
 * live round-trips through FreeLLMAPI run ~5s, so the mock default would
 * queue-pile. Applied as a manager-level default only; SCHEDULER_DEFAULTS
 * (contracts) stays untouched and an explicit config override always wins.
 */
export const LIVE_DECISION_COOLDOWN_MS = 6000;

/** VITE_MODEL_MODE, read defensively (absent under plain node). */
function detectModelMode(): string | undefined {
  return typeof import.meta !== "undefined" && import.meta.env
    ? (import.meta.env.VITE_MODEL_MODE as string | undefined)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentUtcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AgentManagerOpts {
  config?: Partial<SchedulerConfig>;
  /** Base router override (tests). Default: getRouter() per decision. */
  router?: Router;
  bus?: EventBus;
  /** Model-mode override (tests). Default: import.meta.env.VITE_MODEL_MODE. */
  modelMode?: string;
  /**
   * v2 — cognition override (tests); `null` disables cognition entirely.
   * Default: a fresh CognitionSystem sharing this manager's bus + mode.
   * NOTE: an injected `router` does NOT make cognition live — cognition's
   * live/mock split follows VITE_MODEL_MODE (or `modelMode`) only, so
   * router-stub tests keep exact call counts.
   */
  cognition?: CognitionSystem | null;
}

export class AgentManager {
  readonly config: SchedulerConfig;
  private readonly baseRouter: Router | null;
  private readonly bus: EventBus;
  private readonly cognitionSystem: CognitionSystem | null;

  private agentList: Agent[] = [];
  private running = false;
  private paused = false;
  private speed = 1;
  private inFlight = 0;
  private readonly lastDecisionAt = new Map<string, number>();
  /** v3 — guard so seedEvent only fires once even if start() is called again */
  private eventSeeded = false;
  /** LIVE-router decisions this UTC date (cost ceiling) — NOT all cycles. */
  private decisionsThisUtcDay = 0;
  private utcDayKey = currentUtcDayKey();
  private ceilingReached = false;
  /** llm_offline latch (v2 kill-switch visibility, domain rule 13) */
  private llmOffline = false;
  private unsubscribeBus: (() => void) | null = null;

  constructor(opts: AgentManagerOpts = {}) {
    const mode = opts.modelMode ?? detectModelMode();
    const defaults: SchedulerConfig =
      mode === "live"
        ? { ...SCHEDULER_DEFAULTS, decisionCooldownMs: LIVE_DECISION_COOLDOWN_MS }
        : { ...SCHEDULER_DEFAULTS };
    this.config = { ...defaults, ...opts.config };
    this.baseRouter = opts.router ?? null;
    this.bus = opts.bus ?? getEventBus();
    this.cognitionSystem =
      opts.cognition !== undefined
        ? opts.cognition
        : new CognitionSystem({
            bus: this.bus,
            ...(mode !== undefined ? { modelMode: mode } : {}),
          });
  }

  // -- lifecycle -----------------------------------------------------------

  /** Create agents from personas, register sprites, start the loops. */
  start(personas: Persona[] = PERSONAS): void {
    if (this.running) return;
    this.running = true;
    const api = getRenderApi();
    for (const p of personas) {
      const agent = new Agent(p);
      this.agentList.push(agent);
      api?.registerAgentSprite(agent.name, agent.color, agent.pos);
      this.cognitionSystem?.registerAgent(agent);
    }
    // v2 rule 12 — pre-warm plans on every day_advanced (and day 1 now);
    // ensurePlan() inside observation enrichment is the hard guarantee.
    // v3 recurring — also seed a new gathering on each even day (every 2 days).
    if (this.cognitionSystem) {
      const cognition = this.cognitionSystem;
      this.unsubscribeBus = this.bus.on((e) => {
        if (e.kind === "day_advanced") {
          cognition.onDayAdvanced();
          // Seed a gathering for every even day ≥ 2 (cadence: every 2 days).
          // Guard against double-seeding (day-2 is already seeded in start()).
          try {
            const newDay = e.day;
            if (shouldSeedGathering(newDay)) {
              const eventId = `party-d${newDay}`;
              if (!cognition.events.get(eventId)) {
                const tavernPos = getWorld().landmarks().find((l) => l.kind === "tavern")?.pos;
                if (tavernPos) {
                  const sageAgent =
                    this.agentList.find((a) => a.persona.id === "sage") ?? this.agentList[0];
                  if (sageAgent) {
                    cognition.seedEvent(
                      buildGatheringEvent(newDay, sageAgent.name, tavernPos),
                    );
                  }
                }
              }
            }
          } catch {
            /* defensive — recurring seed must never break the day_advanced handler */
          }
        }
      });
      cognition.onDayAdvanced();
    }
    for (const agent of this.agentList) {
      void this.loop(agent);
    }

    // v3 — seed the party event once, after agents are registered
    if (this.cognitionSystem && this.agentList.length > 0 && !this.eventSeeded) {
      this.eventSeeded = true;
      try {
        const tavernPos = getWorld().landmarks().find((l) => l.kind === "tavern")?.pos;
        if (tavernPos) {
          const sageAgent =
            this.agentList.find((a) => a.persona.id === "sage") ?? this.agentList[0];
          this.cognitionSystem.seedEvent({
            id: "party-d2",
            host: sageAgent.name,
            location: tavernPos,
            day: 2,
            phase: "evening",
            description: "a gathering at the tavern",
          });
        }
      } catch {
        /* defensive — event seeding must never break start() */
      }
    }
  }

  /** Stop all loops (tests / teardown). Idempotent. */
  stop(): void {
    this.running = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
  }

  /** v2 — cognition layer (inspector/obs access); null when disabled. */
  cognition(): CognitionSystem | null {
    return this.cognitionSystem;
  }

  // -- HUD API --------------------------------------------------------------

  pause(): void {
    this.paused = true;
    getTimeSystem().pause();
  }

  resume(): void {
    this.paused = false;
    getTimeSystem().resume();
  }

  isPaused(): boolean {
    return this.paused;
  }

  setSpeed(multiplier: Speed): void {
    this.speed = multiplier;
    getTimeSystem().setSpeed(multiplier);
  }

  getSpeed(): number {
    return this.speed;
  }

  agents(): Agent[] {
    return [...this.agentList];
  }

  /**
   * Step: run exactly ONE full decision cycle (think + execute) for the
   * IDLE agent that has waited the longest. Works while paused; ignores the
   * cooldown. Resolves when the cycle completes. No-op when no agent is IDLE.
   */
  async step(): Promise<void> {
    // Mortality: the dead are never scheduled — they stop acting entirely.
    const idle = this.agentList.filter((a) => a.alive !== false && a.fsm === "IDLE");
    if (idle.length === 0) return;
    idle.sort(
      (a, b) =>
        (this.lastDecisionAt.get(a.name) ?? 0) -
        (this.lastDecisionAt.get(b.name) ?? 0),
    );
    try {
      await this.runCycle(idle[0], { ignorePause: true });
    } catch (err) {
      this.emitAgentError(idle[0], err); // HUD's await must never reject
    }
  }

  // -- internals -----------------------------------------------------------

  private cooldownMs(): number {
    return this.config.decisionCooldownMs / Math.max(0.0001, this.speed);
  }

  private async loop(agent: Agent): Promise<void> {
    while (this.running) {
      await sleep(POLL_MS);
      if (!this.running) break;
      if (this.paused) continue;
      // Mortality: a dead agent is never selected for a decision cycle. It
      // stays in agentList (the UI still sees it) but its loop idles forever.
      if (agent.alive === false) continue;
      if (agent.fsm !== "IDLE") continue; // step() may have it busy
      const last = this.lastDecisionAt.get(agent.name);
      if (last !== undefined && Date.now() - last < this.cooldownMs()) continue;
      if (this.inFlight >= this.config.maxConcurrentDecisions) continue;
      // Catch-all (QE finding): an agent loop must NEVER die. runCycle is
      // already defended end to end, so this only fires on a truly novel
      // failure; the turn is logged as agent_error and the FSM is back at
      // IDLE (runCycle's finally), so the agent retries after its cooldown.
      try {
        await this.runCycle(agent, {});
      } catch (err) {
        this.emitAgentError(agent, err);
      }
    }
  }

  /** Best-effort agent_error event — must itself never throw. */
  private emitAgentError(agent: Agent, err: unknown): void {
    try {
      const t = getWorld().time();
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "agent_error",
        agentName: agent.name,
        turnId: `${agent.name}-${agent.turnCounter}`,
        text: `${agent.name}'s decision cycle failed: ${
          err instanceof Error ? err.message : String(err)
        } — recovering after cooldown`,
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      /* a broken bus must not take the loop down with it */
    }
  }

  private rolloverUtcDay(): void {
    const key = currentUtcDayKey();
    if (key === this.utcDayKey) return;
    this.utcDayKey = key;
    this.decisionsThisUtcDay = 0;
    this.ceilingReached = false;
    for (const a of this.agentList) a.decisionsToday = 0;
  }

  /**
   * Would the NEXT decision for this agent hit the live (costed) path?
   * False when the manager latch is down, the agent is on its per-agent
   * budget fallback, or the base router IS the mock (VITE_MODEL_MODE=mock /
   * unset). An injected test router counts as live.
   */
  private nextDecisionIsLive(agent: Agent): boolean {
    if (this.ceilingReached || agent.budgetFallback) return false;
    return (this.baseRouter ?? getRouter()) !== mockRouter;
  }

  private routerForDecision(agent: Agent): Router {
    if (this.ceilingReached || agent.budgetFallback) return mockRouter;
    return this.baseRouter ?? getRouter();
  }

  private async runCycle(
    agent: Agent,
    opts: { ignorePause?: boolean },
  ): Promise<void> {
    this.rolloverUtcDay();
    // CEILING math counts live (costed) decisions ONLY — mock turns are $0
    // and must never trip the kill-switch (W4 finding). agent.decisionsToday/
    // decisionsTotal keep counting EVERY cycle for the HUD (AgentRuntime).
    const liveDecision = this.nextDecisionIsLive(agent);
    if (liveDecision) {
      this.decisionsThisUtcDay++;
      // maxDecisionsPerDay <= 0 means UNLIMITED — the ceiling is opt-in only
      // (FreeLLMAPI is free, so we never self-throttle by default).
      if (
        this.config.maxDecisionsPerDay > 0 &&
        this.decisionsThisUtcDay > this.config.maxDecisionsPerDay
      ) {
        this.ceilingReached = true;
        const t = getWorld().time();
        this.bus.emit({
          day: t.day,
          phase: t.phase,
          kind: "budget_reached",
          text: `Daily live-decision ceiling (${this.config.maxDecisionsPerDay}) reached — all agents fall back to the mock heuristic`,
          payload: { scope: "manager", ceiling: this.config.maxDecisionsPerDay },
        });
      }
    }

    // Semaphore slot covers THINKING only; released when EXECUTING begins.
    this.inFlight++;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };

    agent.fsm = "THINKING";
    try {
      await runDecisionCycle(agent, {
        world: getWorld(),
        agents: this.agentList,
        bus: this.bus,
        router: this.routerForDecision(agent),
        ...(this.cognitionSystem ? { cognition: this.cognitionSystem } : {}),
        onLlmResult: (r) => this.trackLlmHealth(liveDecision, r),
        onExecuting: () => {
          release();
          agent.fsm = "EXECUTING";
        },
        executorOpts: {
          isPaused: () => (opts.ignorePause ? false : this.paused),
          speed: () => this.speed,
        },
      });
    } finally {
      release();
      agent.fsm = "IDLE";
      this.lastDecisionAt.set(agent.name, Date.now());
    }
  }

  /**
   * v2 kill-switch visibility (rule 13): the FIRST failing live decision
   * emits llm_offline {reason}; the next succeeding live decision emits
   * llm_recovered. budget_exceeded is excluded — that path already emits
   * budget_reached (domain rule 5) and is a deliberate, not broken, state.
   * Mock decisions (model "mock") never touch the latch.
   */
  private trackLlmHealth(
    liveDecision: boolean,
    r: { ok: boolean; model: string; error?: string },
  ): void {
    if (!liveDecision || r.model === "mock") return;
    const t = getWorld().time();
    if (!r.ok) {
      if (r.error?.startsWith("budget_exceeded")) return;
      if (this.llmOffline) return;
      this.llmOffline = true;
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "llm_offline",
        text: `Live LLM routing is failing (${r.error ?? "unknown error"}) — agents degrade to the heuristic`,
        payload: { reason: r.error ?? "unknown error" },
      });
    } else if (this.llmOffline) {
      this.llmOffline = false;
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "llm_recovered",
        text: "Live LLM routing recovered — full cognition restored",
        payload: {},
      });
    }
  }
}

// -- singleton (consumed by bootstrap + obs-agent's UIScene) ----------------

let manager: AgentManager | null = null;

export function getAgentManager(): AgentManager {
  if (!manager) manager = new AgentManager();
  return manager;
}

/** Test-only escape hatch. */
export function resetAgentManagerForTests(): void {
  manager?.stop();
  manager = null;
}
