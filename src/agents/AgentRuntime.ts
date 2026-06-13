/**
 * AgentRuntime — one decision cycle for one agent.
 *
 * PDoM port (backend/petridish/agents/runtime.py run_turn, see PROVENANCE):
 * build observation -> prompts -> router -> parse, ONE retry with the problem
 * appended, second failure -> WAIT + parse_failure -> executor -> events.
 *
 * Event chain per decision, all under one turnId `${name}-${counter}`:
 *   turn_start -> llm_call (one per attempt) -> action_chosen ->
 *   action_resolved, plus domain events (agent_speech, agent_moved, economy,
 *   day_advanced, parse_failure, budget_reached).
 */
import type {
  AgentAction,
  EventBus,
  LlmResponse,
  Router,
  WorldApi,
  WorldEvent,
} from "@contracts/types";
import { getRouter, mockRouter } from "../llm/router";
import { buildSystemPrompt, buildUserPrompt } from "../llm/prompts";
import { getRenderApi } from "../world/render";
import type { Agent } from "./Agent";
import { buildObservation } from "./Observation";
import { executeAction, type ExecutorOpts } from "./ActionExecutor";
import type { CognitionSystem } from "./Cognition";

export interface RuntimeCtx {
  world: WorldApi;
  /** all agents (self included; the runtime filters itself out) */
  agents: Agent[];
  bus: EventBus;
  /**
   * Router for this decision (manager applies the daily-ceiling fallback).
   * Defaults to getRouter() — called per decision (domain rule 7).
   */
  router?: Router;
  executorOpts?: ExecutorOpts;
  /** Called when THINKING ends and EXECUTING begins (semaphore release). */
  onExecuting?: () => void;
  /**
   * v2 — generative-agents layer. When present: observation enrichment
   * (plan step / memories / relationships), rule-9 memory writes, and the
   * executor's gift/talk hooks. Absent = exact v1 behavior.
   */
  cognition?: CognitionSystem;
  /**
   * v2 — per-LLM-call health signal for the manager's llm_offline /
   * llm_recovered tracking (fired after every router call, ok or not).
   */
  onLlmResult?: (r: { ok: boolean; model: string; error?: string }) => void;
}

const RETRY_INSTRUCTION =
  'Your previous response could not be parsed into a valid action JSON. ' +
  'Reply must begin with { and contain ONLY one JSON object matching the schema. ' +
  'If unsure, use: {"thought":"fallback","say":null,"action":"WAIT"}';

/** Human-readable lastSeenDoing line for an accepted action. */
export function describeAction(a: AgentAction): string {
  const t = a.target as
    | { x?: number; y?: number; itemId?: string; qty?: number; agentName?: string }
    | undefined;
  switch (a.action) {
    case "MOVE_TO":
      return `walking to (${t?.x},${t?.y})`;
    case "TILL":
      return `tilling (${t?.x},${t?.y})`;
    case "PLANT":
      return `planting at (${t?.x},${t?.y})`;
    case "WATER":
      return `watering (${t?.x},${t?.y})`;
    case "HARVEST":
      return `harvesting (${t?.x},${t?.y})`;
    case "BUY":
      return `buying ${t?.qty}x ${t?.itemId}`;
    case "SELL":
      return `selling ${t?.qty}x ${t?.itemId}`;
    case "TALK_TO":
      return `talking to ${t?.agentName}`;
    case "GIVE_GIFT":
      return `giving ${t?.itemId} to ${t?.agentName}`;
    case "EMOTE":
      return `showing a ${a.emotion ?? "neutral"} face`;
    case "SLEEP":
      return "sleeping";
    case "WAIT":
    default:
      return "idling";
  }
}

/**
 * Run one full decision cycle. Never throws; every outcome (including parse
 * failures and router errors) resolves to an executed action + a complete
 * event chain.
 */
export async function runDecisionCycle(
  agent: Agent,
  ctx: RuntimeCtx,
): Promise<void> {
  const { world, bus } = ctx;
  const others = ctx.agents.filter((o) => o !== agent);
  const turnId = `${agent.name}-${++agent.turnCounter}`;

  const emit = (
    kind: string,
    text: string,
    payload?: Record<string, unknown>,
  ): void => {
    const t = world.time();
    const evt: Omit<WorldEvent, "seq" | "ts"> = {
      day: t.day,
      phase: t.phase,
      kind,
      agentName: agent.name,
      turnId,
      text,
    };
    if (payload) evt.payload = payload;
    bus.emit(evt);
  };

  agent.decisionsToday++;
  agent.decisionsTotal++;

  emit("turn_start", `${agent.name} is deciding what to do`);

  const decisionTime = world.time();
  const observation = buildObservation(agent, world, others);
  // v2 — cognition enrichment BEFORE serializing: plan step, top-5 memories,
  // relationships land in both the prompt and the decision trace. Also
  // guarantees the DailyPlan exists before the first decision of the day
  // (rule 12). Defensive inside; a cognition failure yields a v1 obs.
  if (ctx.cognition) {
    await ctx.cognition.enrichObservation(observation, agent);
  }
  const observationJson = JSON.stringify(observation);
  const system = buildSystemPrompt(agent.persona.description);
  const user = buildUserPrompt(observation);

  let router: Router =
    agent.budgetFallback ? mockRouter : (ctx.router ?? getRouter());

  const call = async (r: Router, userPrompt: string): Promise<LlmResponse> => {
    let res: LlmResponse;
    const started = Date.now();
    try {
      res = await r({ agentId: agent.name, system, user: userPrompt });
    } catch (err) {
      // Routers are documented never to throw — but a custom/buggy one can
      // (QE finding). Convert the rejection to error-LlmResponse semantics:
      // failed turn -> WAIT below, no retry storm, loop survives.
      res = {
        raw: "",
        model: "unknown",
        latencyMs: Date.now() - started,
        error: `router_threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    emit(
      "llm_call",
      `${agent.name} <- ${res.model} (${res.latencyMs}ms)` +
        (res.error ? ` error: ${res.error}` : ""),
      {
        model: res.model,
        latencyMs: res.latencyMs,
        ...(res.tokensIn !== undefined ? { tokensIn: res.tokensIn } : {}),
        ...(res.tokensOut !== undefined ? { tokensOut: res.tokensOut } : {}),
        ...(res.error ? { error: res.error } : {}),
      },
    );
    // v2 — health signal for the manager's llm_offline/llm_recovered logic.
    ctx.onLlmResult?.({
      ok: !res.error,
      model: res.model,
      ...(res.error ? { error: res.error } : {}),
    });
    return res;
  };

  let res = await call(router, user);

  // Domain rule 5: budget_exceeded switches THIS agent permanently to the
  // mock heuristic; the decision is re-made via mock so the turn still acts.
  if (res.error?.startsWith("budget_exceeded")) {
    if (!agent.budgetFallback) {
      agent.budgetFallback = true;
      emit(
        "budget_reached",
        `${agent.name} hit the server budget — switching to the mock heuristic`,
        { scope: "agent" },
      );
    }
    router = mockRouter;
    res = await call(router, user);
  }

  let action: AgentAction | null = res.parsed ?? null;

  // Parse failure (no parsed, no error): ONE retry with the problem appended
  // (PDoM pattern), then WAIT + parse_failure.
  if (!action && !res.error) {
    res = await call(router, `${user}\n${RETRY_INSTRUCTION}`);
    action = res.parsed ?? null;
    if (!action && !res.error) {
      emit(
        "parse_failure",
        `${agent.name} failed to produce a valid action twice — waiting`,
        { raw: res.raw.slice(0, 400) },
      );
    }
  }

  const parsedOk = action !== null;
  if (!action) {
    // Router error or double parse failure: the turn degrades to WAIT so the
    // event chain stays complete and the agent stays alive.
    action = {
      thought: res.error
        ? `LLM call failed: ${res.error}`
        : "Could not produce a valid action — waiting.",
      say: null,
      action: "WAIT",
    };
  }

  if (typeof action.goal === "string" && action.goal.length > 0) {
    agent.goal = action.goal;
  }
  agent.lastThought = action.thought;
  agent.lastSay = action.say;
  agent.lastSeenDoing = describeAction(action);

  emit("action_chosen", `${agent.name} chose ${action.action}`, {
    action: action.action,
    thought: action.thought,
    say: action.say,
    goal: agent.goal,
    ...(action.target !== undefined ? { target: action.target } : {}),
  });

  if (action.say) {
    getRenderApi()?.showSpeech(agent.name, action.say, action.emotion ?? "neutral");
    emit("agent_speech", `${agent.name}: ${action.say}`, { say: action.say });
    // Rule 9: everyone in earshot remembers what they heard.
    ctx.cognition?.recordSpeech(agent, action.say, others);
  }

  // THINKING -> EXECUTING (the manager releases its semaphore slot here).
  ctx.onExecuting?.();

  // The executor reports gift/talk side-effects to the cognition layer.
  const execOpts: ExecutorOpts = {
    ...ctx.executorOpts,
    ...(ctx.executorOpts?.cognition || !ctx.cognition
      ? {}
      : { cognition: ctx.cognition }),
  };

  const result = await executeAction(agent, action, world, others, execOpts);

  agent.lastAction = {
    action: action.action,
    ok: result.ok,
    ...(result.reason ? { reason: result.reason } : {}),
  };

  emit(
    "action_resolved",
    `${agent.name} ${action.action} ${result.ok ? "ok" : `rejected: ${result.reason}`}`,
    {
      action: action.action,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      energy: agent.energy,
      gold: agent.gold,
    },
  );

  if (result.ok) {
    if (action.action === "MOVE_TO") {
      emit(
        "agent_moved",
        `${agent.name} arrived at (${agent.pos.x},${agent.pos.y})`,
        { pos: { ...agent.pos } },
      );
    } else if (action.action === "BUY" || action.action === "SELL") {
      const t = action.target as { itemId: string; qty: number };
      emit(
        "economy",
        `${agent.name} ${action.action === "BUY" ? "bought" : "sold"} ${Math.floor(t.qty)}x ${t.itemId} (now ${agent.gold}g)`,
        {
          kind: action.action,
          itemId: t.itemId,
          qty: Math.floor(t.qty),
          gold: agent.gold,
        },
      );
    } else if (action.action === "SLEEP") {
      emit(
        "day_advanced",
        `${agent.name} slept — day ${world.time().day} begins`,
        { day: world.time().day },
      );
    } else if (action.action === "GIVE_GIFT") {
      const t = action.target as { agentName: string; itemId: string };
      emit("gift_given", `${agent.name} gave ${t.agentName} 1x ${t.itemId}`, {
        from: agent.name,
        to: t.agentName,
        itemId: t.itemId,
      });
    } else if (action.action === "EMOTE") {
      const emotion = action.emotion ?? "neutral";
      emit("agent_emote", `${agent.name} emotes: ${emotion}`, { emotion });
    }
  }

  // Rule 9: every resolved action becomes a memory (fire-and-forget inside).
  ctx.cognition?.recordOutcome(agent, action, result);

  agent.pushTrace({
    turnId,
    day: decisionTime.day,
    phase: decisionTime.phase,
    observationJson,
    rawResponse: res.raw,
    parsedOk,
    action: parsedOk ? action.action : null,
    model: res.model,
    latencyMs: res.latencyMs,
    ...(res.tokensIn !== undefined ? { tokensIn: res.tokensIn } : {}),
    ...(res.tokensOut !== undefined ? { tokensOut: res.tokensOut } : {}),
  });
}
