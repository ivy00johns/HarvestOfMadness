/**
 * inspectorRail — pure SpaceCon INSPECTOR-rail projections (no Phaser import,
 * headlessly testable). UIScene's tall inspector card reads these for its four
 * decision-trace nodes, its model/cost strip, and its memory-stream tag chips,
 * so the honest-data rules (README §6, contracts/phase-b-rail-inspector.md) live
 * in ONE source of truth instead of being re-inlined in the scene draw.
 *
 * HONESTY discipline (load-bearing):
 *  - DecisionTraceEntry has NO per-entry thought or result field. The Thought
 *    node derives from the newest entry (lastThought / parsed rawResponse);
 *    older entries honestly show "—". The Result node uses the card's
 *    lastAction for the newest entry, and the entry's parsedOk status otherwise
 *    — never a fabricated outcome.
 *  - Cost is NOT tracked. The model strip shows model·latency·tokens only
 *    (mock → "mock · 0 ms · 0 tok"); no invented dollar figure.
 */
import type {
  DecisionTraceEntry,
  MemoryEntry,
  MemoryType,
} from "@contracts/types";
import {
  brand400,
  brand500,
  cyan300,
  cyan500,
  ink300,
  ink500,
  obsTagFill,
  positive500,
  tintPlan,
  tintReflect,
  white,
  type Tint,
} from "./theme";
import { parseAgentAction } from "../llm/parse";

/** A resolved trace-timeline node: node-dot color, label color + text, body color + text. */
export interface TraceNode {
  /** Mono uppercase label (OBSERVATION / THOUGHT / ACTION / RESULT). */
  label: string;
  /** Timeline node-dot color (theme token `num`). */
  nodeColor: number;
  /** Label text color (theme token `num`). */
  labelColor: number;
  /** Body text color (theme token `num`). */
  textColor: number;
  /** The honest body text (already clipped by the caller as needed). */
  text: string;
  /** Body rendered italic (Thought node only). */
  italic: boolean;
}

/** Card-shaped projection the inspector trace nodes read from. */
export interface InspectorTraceInput {
  /** Newest-first trace (AgentCardModel.trace); [0] is the current turn. */
  trace: DecisionTraceEntry[];
  /** Card lastThought (already derived by buildAgentCard for the newest turn). */
  lastThought: string | null;
  /** Card lastAction — the only real per-turn RESULT we have (newest turn). */
  lastAction: { action: string; ok: boolean; reason?: string } | null;
}

/** Default body-text budgets (the rail is ~340px wide; keep nodes scannable). */
export const OBSERVATION_NODE_MAX = 150;
export const THOUGHT_NODE_MAX = 160;
export const ACTION_NODE_MAX = 60;
export const RESULT_NODE_MAX = 120;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Summarize the raw observation JSON into a short "what the agent saw" line —
 * position, energy, gold, nearby targets — instead of dumping 500 chars of
 * JSON. Defensive: a malformed/empty observation falls back to a clipped raw
 * string (never throws, never fabricates).
 */
export function summarizeObservation(observationJson: string): string {
  if (!observationJson) return "—";
  try {
    const o = JSON.parse(observationJson) as {
      self?: { pos?: { x: number; y: number }; energy?: number; gold?: number };
      nearby?: { agents?: { name: string }[]; landmarks?: { kind: string }[] };
    };
    const parts: string[] = [];
    const pos = o.self?.pos;
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      parts.push(`at (${pos.x},${pos.y})`);
    }
    if (typeof o.self?.energy === "number") parts.push(`E${Math.round(o.self.energy)}`);
    if (typeof o.self?.gold === "number") parts.push(`${o.self.gold}g`);
    const agents = o.nearby?.agents ?? [];
    if (agents.length > 0) {
      parts.push(`near ${agents.slice(0, 2).map((a) => a.name).join(", ")}`);
    }
    const marks = o.nearby?.landmarks ?? [];
    if (marks.length > 0) {
      parts.push(`${marks.length} landmark${marks.length === 1 ? "" : "s"}`);
    }
    return parts.length > 0 ? clip(parts.join(" · "), OBSERVATION_NODE_MAX) : "—";
  } catch {
    return clip(observationJson, OBSERVATION_NODE_MAX);
  }
}

/**
 * Derive the THOUGHT text honestly. Trace entries have no stored thought field;
 * only the NEWEST turn's thought is recoverable (the card's lastThought, or a
 * defensive re-parse of the entry's raw response). Older entries → "—".
 */
export function thoughtText(input: InspectorTraceInput): string {
  const newest = input.trace[0] ?? null;
  if (!newest) return "—";
  if (input.lastThought && input.lastThought.trim().length > 0) {
    return clip(input.lastThought, THOUGHT_NODE_MAX);
  }
  if (newest.parsedOk) {
    const parsed = parseAgentAction(newest.rawResponse);
    if (parsed?.thought && parsed.thought.trim().length > 0) {
      return clip(parsed.thought, THOUGHT_NODE_MAX);
    }
  }
  return "—";
}

/** ACTION node text from the newest entry's chosen action (honest "—" when none). */
export function actionText(input: InspectorTraceInput): string {
  const newest = input.trace[0] ?? null;
  if (!newest || !newest.action) return "—";
  return clip(newest.action, ACTION_NODE_MAX);
}

/**
 * RESULT node text — the honest part. The newest turn has a real outcome on the
 * card's lastAction (ok/reason); older entries (and turns with no lastAction)
 * have NO per-entry result, so we show the entry's parsedOk status, never an
 * invented outcome.
 */
export function resultText(input: InspectorTraceInput): string {
  const newest = input.trace[0] ?? null;
  if (!newest) return "—";
  const la = input.lastAction;
  if (la) {
    const verdict = la.ok ? "ok" : "rejected";
    return la.reason ? clip(`${verdict} · ${la.reason}`, RESULT_NODE_MAX) : verdict;
  }
  // No per-entry result is tracked — report the parse status, honestly.
  return newest.parsedOk ? "parsed ok (outcome not tracked)" : "parse failure";
}

/**
 * The four decision-trace nodes (Observation → Thought → Action → Result) for
 * the inspector timeline, colored per README §6. Reads REAL trace data; the
 * Result node is honest about what is not per-entry tracked.
 */
export function traceNodes(input: InspectorTraceInput): [TraceNode, TraceNode, TraceNode, TraceNode] {
  const newest = input.trace[0] ?? null;
  return [
    {
      label: "OBSERVATION",
      nodeColor: ink500.num,
      labelColor: ink500.num,
      textColor: ink300.num,
      text: newest ? summarizeObservation(newest.observationJson) : "—",
      italic: false,
    },
    {
      label: "THOUGHT",
      nodeColor: cyan500.num,
      labelColor: cyan300.num,
      // README §6 calls for --ink-200 here; theme.ts pins ink300 as the lightest
      // body token (no ink200 in the locked set), so the italic thought body
      // uses ink300 rather than introducing an unpinned hex.
      textColor: ink300.num,
      text: thoughtText(input),
      italic: true,
    },
    {
      label: "ACTION",
      nodeColor: brand500.num,
      labelColor: brand400.num,
      textColor: white.num,
      text: actionText(input),
      italic: false,
    },
    {
      label: "RESULT",
      nodeColor: positive500.num,
      labelColor: positive500.num,
      textColor: ink300.num,
      text: resultText(input),
      italic: false,
    },
  ];
}

/**
 * Model/cost strip text (README §6): model · latency · tokens. Cost is NOT
 * tracked, so no dollar figure is produced. Mock (no model / "mock") collapses
 * to "mock · 0 ms · 0 tok"; live shows the real model + latency + in/out tokens.
 * Returns the text plus whether to render it in the live (cyan300) accent.
 */
export interface ModelStrip {
  text: string;
  live: boolean;
}

export function modelStrip(card: {
  model: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}): ModelStrip {
  const isMock =
    card.model === null || card.model === "mock" || card.model.trim().length === 0;
  if (isMock) {
    return { text: "mock · 0 ms · 0 tok", live: false };
  }
  const latency = card.latencyMs ?? 0;
  const tin = card.tokensIn ?? 0;
  const tout = card.tokensOut ?? 0;
  return { text: `${card.model} · ${latency} ms · ${tin}/${tout} tok`, live: true };
}

/** A resolved memory tag chip: short label, text color, and the chip fill. */
export interface MemoryTagChip {
  label: string;
  /** Chip label text color (theme token `num`). */
  color: number;
  /** Chip fill (opaque for OBS, a 0.16 tint for REFLECT/PLAN). */
  fill: Tint;
}

const OBS_FILL: Tint = { color: obsTagFill.num, alpha: 1 };

/**
 * Memory tag chip style by memory type (README §6):
 *   observation → "OBS"     (ink300 on the opaque obsTagFill #1f2c46)
 *   reflection  → "REFLECT" (cyan300 on the reflect tint)
 *   plan        → "PLAN"    (brand400 on the plan tint)
 */
export function memoryTagChip(type: MemoryType): MemoryTagChip {
  switch (type) {
    case "reflection":
      return { label: "REFLECT", color: cyan300.num, fill: tintReflect };
    case "plan":
      return { label: "PLAN", color: brand400.num, fill: tintPlan };
    case "observation":
    default:
      return { label: "OBS", color: ink300.num, fill: OBS_FILL };
  }
}

/** Default cap on memory rows shown in the inspector stream. */
export const MEMORY_STREAM_CAP = 8;

/**
 * Order + cap the memory stream for display: newest-first, then by importance
 * (a stable, scannable order), capped to N. Pure; the store array is untouched.
 */
export function orderMemoryStream(
  entries: MemoryEntry[],
  cap = MEMORY_STREAM_CAP,
): MemoryEntry[] {
  // Store is oldest-first; reverse to newest-first, then stable-sort by
  // importance desc so the most poignant recent memories surface.
  const newestFirst = entries.slice().reverse();
  return newestFirst
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.importance - a.m.importance || a.i - b.i)
    .slice(0, Math.max(0, cap))
    .map((x) => x.m);
}
