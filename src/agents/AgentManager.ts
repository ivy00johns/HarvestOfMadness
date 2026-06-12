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

/** Scheduler poll granularity (NOT the decision pace — that's the cooldown). */
const POLL_MS = 100;

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
}

export class AgentManager {
  readonly config: SchedulerConfig;
  private readonly baseRouter: Router | null;
  private readonly bus: EventBus;

  private agentList: Agent[] = [];
  private running = false;
  private paused = false;
  private speed = 1;
  private inFlight = 0;
  private readonly lastDecisionAt = new Map<string, number>();
  /** LIVE-router decisions this UTC date (cost ceiling) — NOT all cycles. */
  private decisionsThisUtcDay = 0;
  private utcDayKey = currentUtcDayKey();
  private ceilingReached = false;

  constructor(opts: AgentManagerOpts = {}) {
    const mode = opts.modelMode ?? detectModelMode();
    const defaults: SchedulerConfig =
      mode === "live"
        ? { ...SCHEDULER_DEFAULTS, decisionCooldownMs: LIVE_DECISION_COOLDOWN_MS }
        : { ...SCHEDULER_DEFAULTS };
    this.config = { ...defaults, ...opts.config };
    this.baseRouter = opts.router ?? null;
    this.bus = opts.bus ?? getEventBus();
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
    }
    for (const agent of this.agentList) {
      void this.loop(agent);
    }
  }

  /** Stop all loops (tests / teardown). Idempotent. */
  stop(): void {
    this.running = false;
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
    const idle = this.agentList.filter((a) => a.fsm === "IDLE");
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
    if (this.nextDecisionIsLive(agent)) {
      this.decisionsThisUtcDay++;
      if (this.decisionsThisUtcDay > this.config.maxDecisionsPerDay) {
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
