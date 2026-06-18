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
  NeedState,
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

  // -- v2 optional fields (cognition-agent provides them when its seams land;
  //    everything below degrades to "absent" without throwing) ----------------
  /** sprite color (Agent.color — what bootstrap passes registerAgentSprite) */
  color?: number;
  /** current DailyPlan step text */
  planStep?: string | null;
  /** Wave 3a — intrinsic drive vector for the card's needs row */
  needs?: NeedState | null;
  /**
   * relationship rows — tolerated shapes: contract `{name, affinity, summary}`
   * arrays, RelationshipSummary `{otherName, affinity, summary}` arrays, or
   * the v1 `Record<string, number>` TALK_TO counter (ignored — not affinity).
   */
  relationships?: unknown;
  /** preferred over `relationships` when present (cognition-agent's choice) */
  relationshipSummaries?: unknown;
  memoryCount?: number;
  reflectionCount?: number;
}

/**
 * Contract card + obs-local extras. `color` links the card to the sprite
 * (v1 defect c); contracts/** stays untouched — this extension lives here.
 */
export interface ObsAgentCardModel extends AgentCardModel {
  color?: number;
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

/** Relationship rows shown on a card (top by |affinity|). */
export const RELATIONSHIP_TOP_N = 3;

/**
 * Normalize whatever relationship shape the agent carries into contract
 * `{name, affinity, summary}` rows. Liberal in what it accepts: items may
 * use `name` or `otherName`; non-arrays (e.g. the v1 Record<string, number>
 * TALK_TO counter — counts, not affinity) normalize to [].
 */
export function normalizeRelationships(
  raw: unknown,
): { name: string; affinity: number; summary: string }[] {
  if (!Array.isArray(raw)) return [];
  const rows: { name: string; affinity: number; summary: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const name =
      typeof r.name === "string"
        ? r.name
        : typeof r.otherName === "string"
          ? r.otherName
          : null;
    const affinity =
      typeof r.affinity === "number" && Number.isFinite(r.affinity)
        ? Math.max(-100, Math.min(100, Math.round(r.affinity)))
        : null;
    if (name === null || affinity === null) continue;
    rows.push({
      name,
      affinity,
      summary: typeof r.summary === "string" ? r.summary : "",
    });
  }
  return rows;
}

/** Top-N rows by |affinity| (strongest bonds AND grudges surface first). */
export function topRelationships<T extends { affinity: number }>(
  rows: T[],
  n: number = RELATIONSHIP_TOP_N,
): T[] {
  return rows
    .slice()
    .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity))
    .slice(0, Math.max(0, n));
}

/** Bar slots in a card affinity meter row. */
export const AFFINITY_BAR_SLOTS = 5;

/**
 * One affinity meter row: "Sage      ██░░░ +24". Monospace text keeps the
 * meter a single Text object per row (no per-row rect churn). Any nonzero
 * affinity lights at least one slot.
 */
export function formatAffinityRow(
  name: string,
  affinity: number,
  nameWidth = 9,
): string {
  const clipped = name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name;
  const padded = clipped.padEnd(nameWidth, " ");
  const magnitude = Math.min(100, Math.abs(affinity));
  let filled = Math.round((magnitude / 100) * AFFINITY_BAR_SLOTS);
  if (magnitude > 0 && filled === 0) filled = 1;
  const bar = "█".repeat(filled) + "░".repeat(AFFINITY_BAR_SLOTS - filled);
  const sign = affinity > 0 ? `+${affinity}` : `${affinity}`;
  return `${padded} ${bar} ${sign}`;
}

/** Bar slots per drive in the card needs row. */
export const NEEDS_BAR_SLOTS = 4;

/**
 * One compact needs row: "E▓▓░░ W▓░░░ S▓▓▓░ N▓░░░ P▓▓░░" — five 4-slot bars,
 * one per drive in DRIVE_KEYS order (Energy/Wealth/Social/Novelty/Purpose),
 * higher = more filled. Reuses the affinity-bar idiom (single Text object).
 * Pure + defensive: non-finite drive values render as empty bars.
 */
export function formatNeedsRow(n: NeedState): string {
  const drives: [string, number][] = [
    ["E", n?.energy ?? 0],
    ["W", n?.wealth ?? 0],
    ["S", n?.social ?? 0],
    ["N", n?.novelty ?? 0],
    ["P", n?.purpose ?? 0],
  ];
  return drives
    .map(([label, raw]) => {
      const v = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      let filled = Math.round(v * NEEDS_BAR_SLOTS);
      if (v > 0 && filled === 0) filled = 1;
      const bar = "▓".repeat(filled) + "░".repeat(NEEDS_BAR_SLOTS - filled);
      return `${label}${bar}`;
    })
    .join(" ");
}

/**
 * Build the contract card for one agent. Thought/say come from defensively
 * re-parsing the newest trace entry's raw response (the trace stores raw
 * model text verbatim); a parse-failed turn yields nulls, never a throw.
 * v2 optional fields ride along only when the agent actually carries them.
 */
export function buildAgentCard(agent: InspectableAgent): ObsAgentCardModel {
  const newest: DecisionTraceEntry | null = agent.trace[0] ?? null;
  const needParse = agent.lastThought === undefined || agent.lastSay === undefined;
  const parsed =
    needParse && newest && newest.parsedOk
      ? parseAgentAction(newest.rawResponse)
      : null;

  const relationships = normalizeRelationships(
    agent.relationshipSummaries !== undefined && Array.isArray(agent.relationshipSummaries)
      ? agent.relationshipSummaries
      : agent.relationships,
  );

  const card: ObsAgentCardModel = {
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

  if (typeof agent.color === "number") card.color = agent.color;
  if (agent.planStep !== undefined) card.planStep = agent.planStep;
  if (agent.needs) card.needs = agent.needs;
  if (relationships.length > 0) card.relationships = relationships;
  if (typeof agent.memoryCount === "number") card.memoryCount = agent.memoryCount;
  if (typeof agent.reflectionCount === "number") {
    card.reflectionCount = agent.reflectionCount;
  }
  return card;
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
