/**
 * Planner (contracts v2, rule 12) — one DailyPlan per agent per day,
 * generated BEFORE the agent's first decision of that day (the cognition
 * layer awaits ensurePlan inside observation enrichment; the day_advanced
 * listener pre-warms plans so live latency doesn't stall first decisions).
 *
 * Live: ONE smart-tier call with buildDailyPlanPrompt(persona + recent
 * reflections + landmarks), parsed defensively and coerced to EXACTLY 4
 * steps, one per phase in order; any garbage falls back to mockDailyPlan.
 * Mock: mockDailyPlan (deterministic, $0).
 *
 * The plan is stored as a `plan` memory and announced via "plan_created".
 */
import type {
  DailyPlan,
  EventBus,
  GameStamp,
  Landmark,
  MemoryEntry,
  Phase,
  Planner,
  PlanStep,
  Router,
} from "@contracts/types";
import { mockDailyPlan } from "../llm/mock";
import { buildDailyPlanPrompt } from "../llm/prompts";
import { extractFirstJsonObject } from "../llm/parse";

const PHASE_ORDER: readonly Phase[] = ["morning", "afternoon", "evening", "night"];
const LANDMARK_KINDS: readonly Landmark["kind"][] = ["shop", "bed", "water", "house", "tavern", "cafe", "office", "park"];

/** Poignancy pinned for plan memories — never LLM-rated (budget rule). */
export const PLAN_MEMORY_IMPORTANCE = 4;
/** Recent reflections fed into the plan prompt. */
export const PLAN_REFLECTION_WINDOW = 3;

export interface PlannerDeps {
  bus: EventBus;
  live: () => boolean;
  router: Router;
  now: () => GameStamp;
  landmarks: () => Landmark[];
  persona: (agentName: string) => string;
  /** last reflections (texts) for the prompt */
  reflections: (agentName: string) => string[];
  /**
   * Wave 3a — optional synthesized standing goal. When present it is injected
   * into the plan prompt (live) and re-weights afternoon/evening branches
   * (mock). Optional → existing test harnesses are unaffected, and the
   * coercePlanSteps / 4-step / night-at-bed shape is UNCHANGED.
   */
  goalOf?: (agentName: string) => string | null;
  /**
   * Wave 5b — optional derived role. When present it is passed to mockDailyPlan
   * so a purposeful agent visits the building tied to its role (merchant→shop,
   * socialite→cafe, banker→office, wanderer→park). Optional → harnesses that
   * leave it undefined get a byte-identical 2-arg / farmer plan. The goal still
   * wins over the role; the coercePlanSteps fallback stays 2-arg.
   */
  roleOf?: (agentName: string) => string | null;
  /** appends a `plan` memory (cognition layer wiring; null on failure) */
  write: (
    agentName: string,
    text: string,
    importance: number,
  ) => Promise<MemoryEntry | null>;
  onLiveCall?: () => void;
}

/** Human-readable plan memory text (also reused by tests). */
export function planMemoryText(plan: DailyPlan): string {
  return `My plan for day ${plan.day}: ${plan.steps
    .map((s) => `${s.phase} — ${s.goal}`)
    .join("; ")}`;
}

export class PlannerImpl implements Planner {
  private readonly plans = new Map<string, DailyPlan>();
  private readonly inflight = new Map<string, Promise<DailyPlan>>();

  constructor(private readonly deps: PlannerDeps) {}

  async planDay(agentName: string, day: number): Promise<DailyPlan> {
    const existing = this.plans.get(agentName);
    if (existing && existing.day === day) return existing; // idempotent per day

    const key = `${agentName}|${day}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.generate(agentName, day).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  current(agentName: string): DailyPlan | null {
    return this.plans.get(agentName) ?? null;
  }

  /** Mark every step belonging to an earlier phase as done. */
  advance(agentName: string, phase: Phase): void {
    const plan = this.plans.get(agentName);
    if (!plan) return;
    const idx = PHASE_ORDER.indexOf(phase);
    if (idx < 0) return;
    for (const step of plan.steps) {
      if (PHASE_ORDER.indexOf(step.phase) < idx) step.done = true;
    }
  }

  /** The step for the given phase — feeds Observation.self.currentPlanStep. */
  currentStep(agentName: string, phase: Phase): PlanStep | null {
    const plan = this.plans.get(agentName);
    return plan?.steps.find((s) => s.phase === phase) ?? null;
  }

  private async generate(agentName: string, day: number): Promise<DailyPlan> {
    const persona = this.deps.persona(agentName);
    // Wave 3a — optional synthesized standing goal (null when absent: existing
    // callers and test harnesses leave goalOf undefined → byte-identical mock).
    const goal = this.deps.goalOf?.(agentName) ?? undefined;
    // Wave 5b — optional derived role (undefined when absent: byte-identical).
    const role = this.deps.roleOf?.(agentName) ?? undefined;
    let steps: PlanStep[];
    let rawText: string;

    if (this.deps.live()) {
      const live = await this.generateLive(agentName, day, persona, goal);
      if (live) {
        ({ steps, rawText } = live);
      } else {
        ({ steps, rawText } = mockDailyPlan(persona, day, goal, role)); // garbage -> mock fallback
      }
    } else {
      ({ steps, rawText } = mockDailyPlan(persona, day, goal, role));
    }

    const plan: DailyPlan = { agentName, day, steps, rawText };
    this.plans.set(agentName, plan);

    await this.deps.write(agentName, planMemoryText(plan), PLAN_MEMORY_IMPORTANCE);

    const t = this.deps.now();
    this.deps.bus.emit({
      day: t.day,
      phase: t.phase,
      kind: "plan_created",
      agentName,
      text: `${agentName} planned day ${day}: ${plan.steps[0].goal}`,
      payload: { day, steps: plan.steps.map((s) => s.goal) },
    });
    return plan;
  }

  private async generateLive(
    agentName: string,
    day: number,
    persona: string,
    goal?: string,
  ): Promise<{ steps: PlanStep[]; rawText: string } | null> {
    try {
      this.deps.onLiveCall?.();
      const res = await this.deps.router({
        agentId: agentName,
        system:
          `You are ${agentName}, a farmer NPC planning your day. ` +
          "Respond with ONLY the requested JSON — no prose, no fences.",
        user: buildDailyPlanPrompt(
          persona,
          day,
          this.deps.reflections(agentName).slice(-PLAN_REFLECTION_WINDOW),
          this.deps.landmarks(),
          goal,
        ),
        tier: "smart",
      });
      if (res.error) return null;
      const steps = coercePlanSteps(res.raw, persona, day);
      return steps ? { steps, rawText: res.raw } : null;
    } catch {
      return null;
    }
  }
}

/**
 * Defensive coercion of raw model output into EXACTLY 4 steps, one per phase
 * in contract order. Steps are matched by phase name when possible, else by
 * position; missing/empty goals borrow from the mock plan for that phase.
 * Returns null when no usable steps exist at all (caller falls back to mock).
 */
export function coercePlanSteps(
  raw: string,
  persona: string,
  day: number,
): PlanStep[] | null {
  const json = extractFirstJsonObject(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const stepsRaw = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) return null;

  const records = stepsRaw.map((s) =>
    typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {},
  );
  const anyGoal = records.some(
    (r) => typeof r.goal === "string" && r.goal.trim().length > 0,
  );
  if (!anyGoal) return null;

  const fallback = mockDailyPlan(persona, day).steps;
  return PHASE_ORDER.map((phase, i) => {
    const byPhase = records.find((r) => r.phase === phase);
    const rec = byPhase ?? records[i] ?? {};
    const goal =
      typeof rec.goal === "string" && rec.goal.trim().length > 0
        ? rec.goal.trim()
        : fallback[i].goal;
    const step: PlanStep = { phase, goal, done: false };
    if (
      typeof rec.targetLandmark === "string" &&
      (LANDMARK_KINDS as readonly string[]).includes(rec.targetLandmark)
    ) {
      step.targetLandmark = rec.targetLandmark as Landmark["kind"];
    }
    return step;
  });
}
