/**
 * Defensive AgentAction extraction (§4.2: always parse defensively — strip
 * fences, take the first balanced `{...}` block — regardless of how well the
 * model behaved).
 */
import type { ActionType, AgentAction, Vec2 } from "@contracts/types";

const ACTION_TYPES: readonly ActionType[] = [
  "MOVE_TO",
  "TILL",
  "PLANT",
  "WATER",
  "HARVEST",
  "BUY",
  "SELL",
  "TALK_TO",
  "SLEEP",
  "WAIT",
];

function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

/** Strip markdown code fences (``` / ```json) so the brace scan sees raw JSON. */
function stripFences(raw: string): string {
  return raw.replace(/```[a-zA-Z0-9_-]*\r?\n?/g, "").replace(/```/g, "");
}

/**
 * Return the first balanced top-level `{...}` substring, string-aware
 * (braces inside JSON strings don't count), or null when none closes.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function isVec2(v: unknown): v is Vec2 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec2).x === "number" &&
    Number.isFinite((v as Vec2).x) &&
    typeof (v as Vec2).y === "number" &&
    Number.isFinite((v as Vec2).y)
  );
}

function isItemTarget(v: unknown): v is { itemId: string; qty: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { itemId?: unknown }).itemId === "string" &&
    typeof (v as { qty?: unknown }).qty === "number" &&
    Number.isFinite((v as { qty: number }).qty)
  );
}

function isAgentTarget(v: unknown): v is { agentName: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { agentName?: unknown }).agentName === "string"
  );
}

/**
 * Shape-check `target` per action. Position actions require Vec2; BUY/SELL
 * require {itemId, qty}; TALK_TO requires {agentName}; SLEEP/WAIT ignore it.
 * Returns the normalized target, `undefined` for target-less actions, or
 * the sentinel `false` when the shape is wrong for the action.
 */
function validateTarget(
  action: ActionType,
  target: unknown,
): AgentAction["target"] | undefined | false {
  switch (action) {
    case "MOVE_TO":
    case "TILL":
    case "PLANT":
    case "WATER":
    case "HARVEST":
      return isVec2(target) ? { x: target.x, y: target.y } : false;
    case "BUY":
    case "SELL":
      return isItemTarget(target) ? { itemId: target.itemId, qty: target.qty } : false;
    case "TALK_TO":
      return isAgentTarget(target) ? { agentName: target.agentName } : false;
    case "SLEEP":
    case "WAIT":
      return undefined; // target ignored
  }
}

/**
 * Extract + validate one AgentAction from raw model text. Returns null when
 * no valid action can be recovered (caller decides retry/WAIT policy).
 */
export function parseAgentAction(raw: string): AgentAction | null {
  const json = extractFirstJsonObject(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  if (!isActionType(obj.action)) return null;

  const target = validateTarget(obj.action, obj.target);
  if (target === false) return null;

  const action: AgentAction = {
    thought: typeof obj.thought === "string" ? obj.thought : "",
    say: typeof obj.say === "string" ? obj.say : null,
    action: obj.action,
  };
  if (target !== undefined) action.target = target;
  if (typeof obj.goal === "string") action.goal = obj.goal;
  return action;
}
