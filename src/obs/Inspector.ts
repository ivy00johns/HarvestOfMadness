/**
 * Inspector — pure projection functions behind the per-agent HUD card (§8,
 * PDoM inspector data model: card + decision trace grouped under turnId).
 *
 * No Phaser, no singletons: UIScene feeds Agent-shaped objects in, gets
 * contract AgentCardModel out. lastThought/lastSay/model/latency/tokens are
 * derived from the NEWEST DecisionTraceEntry (trace is newest-first).
 */
import type {
  AgentCardModel,
  AgentFsmState,
  DecisionTraceEntry,
  InventoryEntry,
  Vec2,
} from "@contracts/types";
import { parseAgentAction } from "../llm/parse";

/** Cap on trace entries carried by a card (contract: "cap ~20 per agent"). */
export const TRACE_CAP = 20;

/** Truncation budgets for the expanded trace view (fits the HUD panel). */
export const TRACE_OBSERVATION_MAX_CHARS = 500;
export const TRACE_RESPONSE_MAX_CHARS = 400;

/**
 * Structural shape of agents-agent's Agent object as consumed here. Kept
 * local so src/obs compiles before src/agents lands; any object with these
 * fields (including the real Agent class) satisfies it.
 */
export interface InspectableAgent {
  name: string;
  /** plain string, or agents-agent's Agent shape `{ id, description }` */
  persona: string | { id: string; description: string };
  pos: Vec2;
  energy: number;
  gold: number;
  inventory: InventoryEntry[];
  goal: string | null;
  lastAction: { action: string; ok: boolean; reason?: string } | null;
  /** when the runtime tracks these directly they win over re-parsing */
  lastThought?: string | null;
  lastSay?: string | null;
  fsm: AgentFsmState;
  decisionsToday: number;
  decisionsTotal: number;
  /** newest-first */
  trace: DecisionTraceEntry[];
}

/** Normalize either persona shape to the display string the card wants. */
export function personaText(p: InspectableAgent["persona"]): string {
  return typeof p === "string" ? p : p.description;
}

/** Truncate with an explicit "(+N chars)" marker so nothing hides silently. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const hidden = text.length - maxChars;
  return `${text.slice(0, maxChars)}… (+${hidden} chars)`;
}

/**
 * Build the contract card for one agent. Thought/say come from defensively
 * re-parsing the newest trace entry's raw response (the trace stores raw
 * model text verbatim); a parse-failed turn yields nulls, never a throw.
 */
export function buildAgentCard(agent: InspectableAgent): AgentCardModel {
  const newest: DecisionTraceEntry | null = agent.trace[0] ?? null;
  const needParse = agent.lastThought === undefined || agent.lastSay === undefined;
  const parsed =
    needParse && newest && newest.parsedOk
      ? parseAgentAction(newest.rawResponse)
      : null;

  return {
    name: agent.name,
    persona: personaText(agent.persona),
    gold: agent.gold,
    energy: agent.energy,
    goal: agent.goal,
    lastThought:
      agent.lastThought !== undefined ? agent.lastThought : parsed?.thought || null,
    lastSay: agent.lastSay !== undefined ? agent.lastSay : parsed?.say ?? null,
    lastAction: agent.lastAction,
    model: newest?.model ?? null,
    latencyMs: newest?.latencyMs ?? null,
    tokensIn: newest?.tokensIn ?? null,
    tokensOut: newest?.tokensOut ?? null,
    decisionsToday: agent.decisionsToday,
    decisionsTotal: agent.decisionsTotal,
    fsm: agent.fsm,
    trace: agent.trace.slice(0, TRACE_CAP),
  };
}

/** Collapsed one-liner for a trace entry in the expandable panel. */
export function formatTraceSummary(e: DecisionTraceEntry, maxChars = 56): string {
  const status = e.parsedOk ? "ok" : "PARSE FAIL";
  const line = `${e.turnId} · D${e.day} ${e.phase} · ${e.action ?? "—"} · ${status} · ${e.model} ${e.latencyMs}ms`;
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/**
 * Expanded trace view: header + raw observation JSON + raw model response,
 * verbatim but truncated to panel budgets. Rendered monospace by UIScene.
 */
export function formatTraceEntry(
  e: DecisionTraceEntry,
  opts: { maxObservationChars?: number; maxResponseChars?: number } = {},
): string {
  const obsMax = opts.maxObservationChars ?? TRACE_OBSERVATION_MAX_CHARS;
  const respMax = opts.maxResponseChars ?? TRACE_RESPONSE_MAX_CHARS;
  const tokens =
    e.tokensIn !== undefined || e.tokensOut !== undefined
      ? ` · tok ${e.tokensIn ?? "?"}/${e.tokensOut ?? "?"}`
      : "";
  const header =
    `[${e.turnId}] D${e.day} ${e.phase} · ${e.model} · ${e.latencyMs}ms${tokens}` +
    ` · ${e.parsedOk ? `action ${e.action ?? "—"}` : "PARSE FAILURE"}`;
  return [
    header,
    "── observation ──",
    truncate(e.observationJson, obsMax),
    "── response ──",
    truncate(e.rawResponse, respMax),
  ].join("\n");
}
