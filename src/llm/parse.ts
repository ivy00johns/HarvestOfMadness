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
  "USE_OBJECT",
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

/**
 * Structural truncation detector — judges the BYTES, independent of any
 * upstream finish_reason (deep-research-v3 lesson: providers lie/omit it).
 * Returns true when, scanning the raw text string-aware from the first `{`,
 * the object never closes: either we end mid-string or with positive brace
 * depth. A response with no `{` at all is "not truncated" (it's just prose) —
 * extraction will return null and the caller retries.
 *
 * Pure + allocation-free; safe on 100KB+ input (single linear scan).
 */
export function isStructurallyTruncated(raw: string): boolean {
  const start = raw.indexOf("{");
  if (start === -1) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let closed = false;
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
      if (depth === 0) {
        closed = true;
        break;
      }
    }
  }
  // Truncated when we ran off the end still inside a string or with unclosed
  // braces (depth > 0). `closed` means we found a balanced top-level object.
  return inString || depth > 0 || !closed;
}

/**
 * Best-effort repair of a TRUNCATED JSON object prefix (the model was cut off
 * mid-object, e.g. finish_reason "length"). Strategy, in order:
 *   1. Take everything from the first `{`.
 *   2. Close an unterminated string (append a `"`), then close every still-open
 *      brace/bracket (append the right number of `}`/`]`) and try to parse.
 *   3. If that fails, backtrack: walk back to the last top-level boundary
 *      OUTSIDE a string (a `,` or a value-ending `}`/`]`/digit/quote), drop the
 *      dangling partial field, re-balance, and retry — comma by comma — until a
 *      prefix parses or we run out of boundaries.
 * Returns the parsed object on success, or null. Never throws.
 *
 * This recovers the leading fields (notably `action`/`target`) when the tail
 * (often a long `thought`/`say`) got chopped — exactly the truncation shape a
 * reasoning-model reroute produces.
 */
export function repairTruncatedJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  const body = raw.slice(start);

  // Track the brace/bracket stack and string state across the whole body so we
  // know how to close it, AND record candidate truncation points (indices,
  // exclusive, where a valid prefix could end) at each top-level comma and at
  // each closed container — outside strings only.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const cutPoints: number[] = [];

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      cutPoints.push(i + 1); // just after a closed container value
    } else if (ch === ",") {
      cutPoints.push(i); // before the comma (drop the comma + partial tail)
    }
  }

  const tryClose = (prefix: string): Record<string, unknown> | null => {
    // Re-scan the prefix to compute what's still open (the global scan above
    // includes the dangling tail we're dropping, so recompute per-attempt).
    const s: string[] = [];
    let str = false;
    let esc = false;
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      if (str) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "{" || ch === "[") s.push(ch);
      else if (ch === "}") {
        if (s[s.length - 1] === "{") s.pop();
      } else if (ch === "]") {
        if (s[s.length - 1] === "[") s.pop();
      }
    }
    let candidate = prefix;
    if (str) candidate += '"'; // close a dangling string
    // Drop a trailing comma or a dangling `"key":` with no value before closing.
    candidate = candidate.replace(/,\s*$/, "").replace(/"[^"]*"\s*:\s*$/, "");
    for (let i = s.length - 1; i >= 0; i--) {
      candidate += s[i] === "{" ? "}" : "]";
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  // Attempt 1: close the whole body as-is.
  const whole = tryClose(body);
  if (whole) return whole;

  // Attempts 2..n: backtrack to each cut point, newest-first, dropping the
  // truncated tail and re-closing the surviving prefix.
  for (let i = cutPoints.length - 1; i >= 0; i--) {
    const prefix = body.slice(0, cutPoints[i]);
    const parsed = tryClose(prefix);
    if (parsed) return parsed;
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

function isObjectTarget(v: unknown): v is { objectId: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { objectId?: unknown }).objectId === "string"
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
    case "USE_OBJECT":
      // objectId required; fall back gracefully to undefined (executor allows omission)
      return isObjectTarget(target) ? { objectId: target.objectId } : undefined;
  }
}

/**
 * Validate one already-parsed JSON object into an AgentAction, or null when it
 * is not a conforming action. Shared by the clean-parse and repaired-parse
 * paths so both apply the identical contract checks.
 */
function validateActionObject(parsed: unknown): AgentAction | null {
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

/**
 * Extract + validate one AgentAction from raw model text. Returns null when
 * no valid action can be recovered (caller decides retry/WAIT policy).
 *
 * Defensive ladder (deep-research-v3 robustness port):
 *   1. First BALANCED `{...}` block (string-aware) → JSON.parse → validate.
 *   2. If that fails AND the bytes look truncated, progressive prefix repair
 *      (close/backtrack the cut-off object) → validate the salvaged action.
 * Never throws on any input (100KB garbage, deep nesting, hostile unicode).
 */
export function parseAgentAction(raw: string): AgentAction | null {
  if (typeof raw !== "string") return null;

  // 1. Clean path — first balanced object, parsed directly.
  const json = extractFirstJsonObject(raw);
  if (json !== null) {
    try {
      const action = validateActionObject(JSON.parse(json));
      if (action) return action;
    } catch {
      /* invalid JSON in the balanced block — fall through to repair */
    }
  }

  // 2. Repair path — only when the response is structurally truncated (no
  //    balanced object closed). Salvages action/target/etc. from the prefix.
  if (json === null && isStructurallyTruncated(raw)) {
    try {
      const repaired = repairTruncatedJson(raw);
      if (repaired) {
        const action = validateActionObject(repaired);
        if (action) return action;
      }
    } catch {
      /* repair is best-effort — never throws out of parse */
    }
  }

  return null;
}
