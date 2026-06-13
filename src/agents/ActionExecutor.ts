/**
 * ActionExecutor — §4.4 precondition table, validated against CURRENT world
 * state at execution time (domain rule 4). Rejects loudly with readable
 * reasons, never throws (rule 1).
 *
 * Effects owned here (contracts/README.md cross-cutting assignments):
 * energy (−ENERGY_COSTS[action] per action, floored at 0 — v1.2 kickoff
 * table: TILL 2 / PLANT 1 / WATER 1 / HARVEST 2, everything else 0),
 * gold/inventory for BUY/SELL, TALK_TO speech + relationship bump, SLEEP
 * energy restore. Tile mutations always go through world.till/plant/water/
 * harvest.
 */
import type {
  ActionResult,
  ActionType,
  AgentAction,
  CropKind,
  Vec2,
  WorldApi,
} from "@contracts/types";
import { ENERGY_COSTS, ENERGY_START } from "@contracts/types";
import { getRenderApi } from "../world/render";
import type { Agent } from "./Agent";
import { chebyshev } from "./Observation";

/**
 * v2 cognition hooks (rule 8/9): the executor reports social side-effects
 * (gift transfers, conversations) so the cognition layer can write the
 * both-sides memories and affinity updates. Structural — CognitionSystem
 * satisfies it; absent in v1-style/unit-test calls.
 */
export interface ExecutorCognitionHooks {
  onGift(giver: Agent, receiver: Agent, itemId: string): void;
  onTalk(speaker: Agent, listener: Agent, say: string | null): void;
}

export interface ExecutorOpts {
  /** scheduler pause hook — walking halts while true */
  isPaused?: () => boolean;
  /** time-speed multiplier (AgentManager.setSpeed) */
  speed?: () => number;
  /** ms per walked tile at speed 1 (default 250) */
  msPerTile?: number;
  /** poll interval while paused mid-walk (default 50ms) */
  pausePollMs?: number;
  /** v2 — cognition side-effect hooks (gift/talk memories + affinity) */
  cognition?: ExecutorCognitionHooks;
}

const DEFAULT_MS_PER_TILE = 250;
const DEFAULT_PAUSE_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reject(reason: string): ActionResult {
  return { ok: false, reason };
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

/**
 * Defense-in-depth qty gate (QE finding: a non-conforming router can bypass
 * parse.ts, and NaN/Infinity/fractional/negative qty would corrupt the
 * economy). Mirrors parse.ts finiteness + adds the whole-number >= 1 rule;
 * returns null when hostile.
 */
function gateQty(raw: number): number | null {
  return Number.isFinite(raw) && Number.isInteger(raw) && raw >= 1
    ? raw
    : null;
}

function isAgentTarget(v: unknown): v is { agentName: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { agentName?: unknown }).agentName === "string"
  );
}

function isGiftTarget(
  v: unknown,
): v is { agentName: string; itemId: string; qty: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { agentName?: unknown }).agentName === "string" &&
    typeof (v as { itemId?: unknown }).itemId === "string" &&
    typeof (v as { qty?: unknown }).qty === "number" &&
    Number.isFinite((v as { qty: number }).qty)
  );
}

/** Charge the v1.2 per-action energy cost (0 for non-field actions). */
function spendEnergy(agent: Agent, action: ActionType): void {
  agent.energy = Math.max(0, agent.energy - (ENERGY_COSTS[action] ?? 0));
}

/** Shared field-action gate: tile target, energy>0, 4-adjacency. */
function fieldGate(
  agent: Agent,
  world: WorldApi,
  target: unknown,
  verb: string,
): { ok: true; pos: Vec2 } | { ok: false; result: ActionResult } {
  if (!isVec2(target)) {
    return { ok: false, result: reject(`${verb} needs a {x,y} tile target`) };
  }
  if (agent.energy <= 0) {
    return {
      ok: false,
      result: reject(`you are out of energy — sleep to recover before you ${verb}`),
    };
  }
  if (!world.isAdjacent(agent.pos, target)) {
    return {
      ok: false,
      result: reject(
        `tile (${target.x},${target.y}) is not adjacent to you at (${agent.pos.x},${agent.pos.y})`,
      ),
    };
  }
  return { ok: true, pos: { x: target.x, y: target.y } };
}

async function walkPath(
  agent: Agent,
  path: Vec2[],
  opts: ExecutorOpts,
): Promise<void> {
  const msPerTile = opts.msPerTile ?? DEFAULT_MS_PER_TILE;
  const pausePoll = opts.pausePollMs ?? DEFAULT_PAUSE_POLL_MS;
  // path includes the start tile (W1 contract) — walk the rest.
  for (let i = 1; i < path.length; i++) {
    while (opts.isPaused?.()) {
      await sleep(pausePoll);
    }
    const speed = Math.max(0.0001, opts.speed?.() ?? 1);
    const delay = msPerTile / speed;
    if (delay > 0) await sleep(delay);
    agent.pos = { ...path[i] };
    getRenderApi()?.setAgentPos(agent.name, agent.pos);
  }
}

export async function executeAction(
  agent: Agent,
  action: AgentAction,
  world: WorldApi,
  others: Agent[],
  opts: ExecutorOpts = {},
): Promise<ActionResult> {
  try {
    switch (action.action) {
      case "MOVE_TO": {
        const target = action.target;
        if (!isVec2(target)) return reject("MOVE_TO needs a {x,y} tile target");
        const tile = world.getTile(target.x, target.y);
        if (!tile) {
          return reject(`tile (${target.x},${target.y}) is outside the map`);
        }
        if (!world.isPassable(target.x, target.y)) {
          return reject(
            `tile (${target.x},${target.y}) is ${tile.type}, not walkable`,
          );
        }
        const path = world.findPath(agent.pos, target);
        if (path === null) {
          return reject(
            `no path from (${agent.pos.x},${agent.pos.y}) to (${target.x},${target.y})`,
          );
        }
        await walkPath(agent, path, opts);
        return { ok: true };
      }

      case "TILL": {
        const gate = fieldGate(agent, world, action.target, "TILL");
        if (!gate.ok) return gate.result;
        const r = world.till(gate.pos);
        if (r.ok) spendEnergy(agent, "TILL");
        return r;
      }

      case "PLANT": {
        const gate = fieldGate(agent, world, action.target, "PLANT");
        if (!gate.ok) return gate.result;
        // Seed choice: first seed held (AgentAction.target for PLANT is the
        // tile; the contract has no per-seed selector).
        const seed = agent.firstSeed();
        if (!seed) return reject("you have no seeds — buy some at the shop");
        const kind = seed.itemId.slice("seed:".length) as CropKind;
        const r = world.plant(gate.pos, kind);
        if (r.ok) {
          agent.removeItem(seed.itemId, 1);
          spendEnergy(agent, "PLANT");
        }
        return r;
      }

      case "WATER": {
        const gate = fieldGate(agent, world, action.target, "WATER");
        if (!gate.ok) return gate.result;
        const r = world.water(gate.pos);
        if (r.ok) spendEnergy(agent, "WATER");
        return r;
      }

      case "HARVEST": {
        const gate = fieldGate(agent, world, action.target, "HARVEST");
        if (!gate.ok) return gate.result;
        const r = world.harvest(gate.pos);
        if (r.ok && r.itemId) {
          agent.addItem(r.itemId, 1);
          spendEnergy(agent, "HARVEST");
        }
        return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
      }

      case "BUY": {
        const target = action.target;
        if (!isItemTarget(target)) {
          return reject("BUY needs an {itemId, qty} target");
        }
        const here = world.getTile(agent.pos.x, agent.pos.y);
        if (here?.type !== "shopTile") {
          return reject("you must stand on the shop tile to BUY");
        }
        const qty = gateQty(target.qty);
        if (qty === null) {
          return reject(`BUY qty must be a whole number >= 1 (got ${target.qty})`);
        }
        const price = world.buyPrices()[target.itemId];
        if (price === undefined) {
          return reject(`the shop does not sell "${target.itemId}"`);
        }
        const cost = price * qty;
        if (agent.gold < cost) {
          return reject(
            `${qty}x ${target.itemId} costs ${cost}g but you only have ${agent.gold}g`,
          );
        }
        agent.gold -= cost;
        agent.addItem(target.itemId, qty);
        return { ok: true };
      }

      case "SELL": {
        const target = action.target;
        if (!isItemTarget(target)) {
          return reject("SELL needs an {itemId, qty} target");
        }
        const here = world.getTile(agent.pos.x, agent.pos.y);
        if (here?.type !== "shopTile") {
          return reject("you must stand on the shop tile to SELL");
        }
        const qty = gateQty(target.qty);
        if (qty === null) {
          return reject(`SELL qty must be a whole number >= 1 (got ${target.qty})`);
        }
        const price = world.sellPrices()[target.itemId];
        if (price === undefined) {
          return reject(`the shop does not buy "${target.itemId}"`);
        }
        const have = agent.countItem(target.itemId);
        if (have < qty) {
          return reject(`you have ${have}x ${target.itemId}, not ${qty}`);
        }
        agent.removeItem(target.itemId, qty);
        agent.gold += price * qty;
        return { ok: true };
      }

      case "TALK_TO": {
        const target = action.target;
        if (!isAgentTarget(target)) {
          return reject("TALK_TO needs an {agentName} target");
        }
        const other = others.find(
          (o) => o.name === target.agentName && o.name !== agent.name,
        );
        if (!other) {
          return reject(`there is no agent named "${target.agentName}" here`);
        }
        if (chebyshev(agent.pos, other.pos) > 1) {
          return reject(
            `${other.name} is too far away to talk to (must be within 1 tile)`,
          );
        }
        const api = getRenderApi();
        // Runtime already bubbles action.say; the executor only adds a
        // default line when the model stayed silent, plus the listener side.
        if (api) {
          if (action.say == null) {
            api.showSpeech(agent.name, `Hi ${other.name}!`);
          }
          api.showSpeech(other.name, `Hey, ${agent.name}.`);
        }
        agent.relationships[other.name] =
          (agent.relationships[other.name] ?? 0) + 1;
        // v2 — affinity both ways + listener memory (rule 9).
        opts.cognition?.onTalk(agent, other, action.say);
        return { ok: true };
      }

      case "GIVE_GIFT": {
        // §4.4 v2 row: receiver exists + 4-adjacent, giver holds itemId
        // qty >= 1; transfers EXACTLY 1 regardless of requested qty.
        const target = action.target;
        if (!isGiftTarget(target)) {
          return reject("GIVE_GIFT needs an {agentName, itemId, qty} target");
        }
        const other = others.find(
          (o) => o.name === target.agentName && o.name !== agent.name,
        );
        if (!other) {
          return reject(`there is no agent named "${target.agentName}" here`);
        }
        if (!world.isAdjacent(agent.pos, other.pos)) {
          return reject(
            `${other.name} is too far away — stand right next to them to give a gift`,
          );
        }
        const qty = gateQty(target.qty);
        if (qty === null) {
          return reject(
            `GIVE_GIFT qty must be a whole number >= 1 (got ${target.qty})`,
          );
        }
        if (agent.countItem(target.itemId) < 1) {
          return reject(`you do not have any "${target.itemId}" to give`);
        }
        agent.removeItem(target.itemId, 1);
        other.addItem(target.itemId, 1);
        spendEnergy(agent, "GIVE_GIFT"); // 0 by table — kept for uniformity
        // v2 — importance-7 memories + affinity, BOTH directions (rule 8).
        opts.cognition?.onGift(agent, other, target.itemId);
        return { ok: true };
      }

      case "EMOTE": {
        // Always legal (rule 8): renders only, mutates nothing.
        getRenderApi()?.playEmote(agent.name, action.emotion ?? "neutral");
        return { ok: true };
      }

      case "SLEEP": {
        const here = world.getTile(agent.pos.x, agent.pos.y);
        if (here?.type !== "bedTile") {
          return reject("you must be on your bed to SLEEP");
        }
        const phase = world.time().phase;
        if (phase !== "night") {
          return reject(`you can only SLEEP at night (it is ${phase})`);
        }
        world.advanceDay();
        agent.energy = ENERGY_START;
        return { ok: true };
      }

      case "WAIT":
        return { ok: true };

      default:
        return reject(`unknown action "${String(action.action)}"`);
    }
  } catch (err) {
    // Rule 1: never crash the loop — surface the failure as a rejection.
    return reject(
      `internal error executing ${action.action}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
