/**
 * Defensive AgentAction extraction (§4.2: always parse defensively —
 * tolerate fences/prose, take the first balanced `{...}` block — regardless
 * of how well the model behaved).
 */
import type { ActionType, AgentAction, Emotion, Vec2 } from "@contracts/types";

const ACTION_TYPES: readonly ActionType[] = [
  "MOVE_TO",
  "TILL",
  "PLANT",
  "WATER",
  "HARVEST",
  "BUY",
  "SELL",
  "TALK_TO",
  "GIVE_GIFT",
  "EMOTE",
  "SLEEP",
  "WAIT",
];

const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "annoyed", "sad", "excited"];

function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

function isEmotion(v: unknown): v is Emotion {
  return typeof v === "string" && (EMOTIONS as readonly string[]).includes(v);
}

/**
 * Return the first balanced top-level `{...}` substring, string-aware
 * (braces inside JSON strings don't count), or null when none closes.
 *
 * Markdown fences (``` / ```json) need no pre-stripping: the scan starts at
 * the first `{` and fence markers live OUTSIDE the object, so they are
 * skipped naturally — and, critically, backtick sequences INSIDE JSON string
 * values are preserved verbatim instead of being mutated (QE finding:
 * a global fence-strip damaged thought/say content).
 */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
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
      if (depth === 0) return raw.slice(start, i + 1);
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

function isGiftTarget(v: unknown): v is { agentName: string; itemId: string; qty: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { agentName?: unknown }).agentName === "string" &&
    typeof (v as { itemId?: unknown }).itemId === "string" &&
    typeof (v as { qty?: unknown }).qty === "number" &&
    Number.isFinite((v as { qty: number }).qty)
  );
}

/**
 * Shape-check `target` per action. Position actions require Vec2; BUY/SELL
 * require {itemId, qty}; TALK_TO requires {agentName}; GIVE_GIFT (v2)
 * requires {agentName, itemId, qty}; SLEEP/WAIT/EMOTE ignore it.
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
    case "GIVE_GIFT":
      return isGiftTarget(target)
        ? { agentName: target.agentName, itemId: target.itemId, qty: target.qty }
        : false;
    case "SLEEP":
    case "WAIT":
    case "EMOTE":
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

  // v2 — optional emotion enum: absent is fine (defaults to "neutral"
  // downstream), but a present-yet-invalid value is a contract violation and
  // rejects the whole action (same loud-rejection policy as bad targets).
  if (obj.emotion !== undefined && !isEmotion(obj.emotion)) return null;

  const action: AgentAction = {
    thought: typeof obj.thought === "string" ? obj.thought : "",
    say: typeof obj.say === "string" ? obj.say : null,
    action: obj.action,
  };
  if (target !== undefined) action.target = target;
  if (typeof obj.goal === "string") action.goal = obj.goal;
  if (obj.emotion !== undefined && isEmotion(obj.emotion)) action.emotion = obj.emotion;
  return action;
}
