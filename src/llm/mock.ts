/**
 * mockRouter — deterministic heuristic farmer (§11). $0, model:"mock",
 * latencyMs 0-5. Parses the Observation embedded in req.user (the user
 * prompt is JSON.stringify(observation) + a trailing question) and returns
 * a valid AgentAction.
 *
 * Decision order is the kickoff-fable5 9-step priority ladder (contracts
 * v1.2, docs/kickoff-fable5.md "Mock farmer decision priority") — first
 * legal step wins. Pinned resolutions:
 *  - step 6: SLEEP only fires at night AND on the bed tile (§4.4 night-gate
 *    wins); energy-0 at bed during the day → WAIT.
 *  - itemIds stay "seed:<kind>" / "crop:<kind>".
 *  - step 8: at night or at energy 0 the destination is the bed — without
 *    this, step 6 is unreachable and the day never advances.
 * Persona flavor is secondary, AFTER the ladder: reckless skip-water lives
 * INSIDE step 4 (skip = fall through to step 5); social TALK_TO can only
 * replace the final WAIT.
 *
 * Deterministic: no Math.random — flavor uses a hash of (agentName + day)
 * so runs replay identically.
 */
import type {
  ActionType,
  AgentAction,
  LlmResponse,
  Observation,
  Router,
  Vec2,
} from "@contracts/types";
import { CROPS } from "@contracts/types";
import { extractFirstJsonObject } from "./parse";

/** djb2 — small deterministic string hash, always non-negative. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/** 4-neighbour adjacency or same tile (matches WorldApi.isAdjacent). */
function isAdjacent(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
}

/** Chebyshev distance — "within 1 tile" for TALK_TO. */
function cheb(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function samePos(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Deterministic nearest pick: distance first, then (y,x) for stable ties. */
function nearest<T extends { x: number; y: number }>(from: Vec2, items: T[]): T | null {
  if (items.length === 0) return null;
  return [...items].sort((p, q) => {
    const d = cheb(from, p) - cheb(from, q);
    if (d !== 0) return d;
    return p.y - q.y || p.x - q.x;
  })[0];
}

function findLandmark(obs: Observation, kind: "shop" | "bed"): Vec2 | null {
  const lm = obs.nearby.landmarks.find((l) => l.kind === kind);
  if (lm) return lm.pos;
  // Fall back to visible bedTile/shopTile tiles when the landmark is absent.
  const tileType = kind === "shop" ? "shopTile" : "bedTile";
  const tile = nearest(
    obs.self.pos,
    obs.nearby.tiles.filter((t) => t.type === tileType),
  );
  return tile ? { x: tile.x, y: tile.y } : null;
}

function act(
  action: ActionType,
  thought: string,
  say: string | null,
  target?: AgentAction["target"],
): AgentAction {
  const a: AgentAction = { thought, say, action };
  if (target !== undefined) a.target = target;
  return a;
}

function moveTo(pos: Vec2, thought: string, say: string | null = null): AgentAction {
  return act("MOVE_TO", thought, say, { x: pos.x, y: pos.y });
}

/** Kickoff 9-step ladder — always respects obs.availableActions. */
function decide(obs: Observation): AgentAction {
  const self = obs.self;
  const pos = self.pos;
  const persona = self.persona.toLowerCase();
  const seed = hash(`${self.name}:${obs.time.day}`);
  const can = (a: ActionType) => obs.availableActions.includes(a);

  const bed = findLandmark(obs, "bed");
  const shop = findLandmark(obs, "shop");
  const atShop = shop !== null && isAdjacent(pos, shop);
  const onBed =
    (bed !== null && samePos(pos, bed)) ||
    obs.nearby.tiles.some((t) => t.type === "bedTile" && samePos(t, pos));
  const night = obs.time.phase === "night";
  const exhausted = self.energy <= 0;

  const seeds = self.inventory.filter((i) => i.itemId.startsWith("seed:") && i.qty > 0);
  const crops = self.inventory.filter((i) => i.itemId.startsWith("crop:") && i.qty > 0);

  const tiles = obs.nearby.tiles;
  const readyCrops = tiles.filter((t) => t.crop?.ready);
  const thirstyCrops = tiles.filter((t) => t.crop && !t.crop.watered && !t.crop.ready);
  const tilledEmpty = tiles.filter((t) => t.type === "tilled" && !t.crop);
  const tillable = tiles.filter(
    (t) => (t.type === "soil" || t.type === "grass") && !t.crop && !samePos(t, pos),
  );

  // Reckless flavor lives INSIDE step 4: skipping means fall through to step 5.
  const recklessSkip = persona.includes("reckless") && seed % 10 < 3;

  // 1. ready crop adjacent → HARVEST
  const ready = nearest(pos, readyCrops.filter((t) => isAdjacent(pos, t)));
  if (ready && can("HARVEST")) {
    return act(
      "HARVEST",
      `The ${ready.crop?.kind ?? "crop"} at (${ready.x},${ready.y}) is ready.`,
      "Harvest time!",
      { x: ready.x, y: ready.y },
    );
  }

  // 2. holding a harvestable crop and at/adjacent to shop → SELL
  if (crops.length > 0 && atShop && can("SELL")) {
    const lot = crops[0];
    return act(
      "SELL",
      `Selling all ${lot.qty} ${lot.itemId} at the shop.`,
      "Fresh produce, straight from the field!",
      { itemId: lot.itemId, qty: lot.qty },
    );
  }

  // 3. tilled & empty tile adjacent and has a seed → PLANT
  if (seeds.length > 0 && can("PLANT")) {
    const plot = nearest(pos, tilledEmpty.filter((t) => isAdjacent(pos, t)));
    if (plot) {
      return act(
        "PLANT",
        `Planting ${seeds[0].itemId} in the tilled plot at (${plot.x},${plot.y}).`,
        null,
        { x: plot.x, y: plot.y },
      );
    }
  }

  // 4. unwatered crop adjacent and energy > 0 → WATER (reckless may skip)
  if (self.energy > 0 && !recklessSkip && can("WATER")) {
    const thirsty = nearest(pos, thirstyCrops.filter((t) => isAdjacent(pos, t)));
    if (thirsty) {
      return act(
        "WATER",
        `The ${thirsty.crop?.kind ?? "crop"} at (${thirsty.x},${thirsty.y}) needs water.`,
        null,
        { x: thirsty.x, y: thirsty.y },
      );
    }
  }

  // 5. untilled soil adjacent and energy > 0 → TILL
  if (self.energy > 0 && can("TILL")) {
    const spot = nearest(pos, tillable.filter((t) => isAdjacent(pos, t)));
    if (spot) {
      return act("TILL", `Tilling the ground at (${spot.x},${spot.y}).`, null, {
        x: spot.x,
        y: spot.y,
      });
    }
  }

  // 6. (energy 0 or night) and at bed → SLEEP — night-gated per §4.4:
  //    SLEEP only at night; energy-0 at bed during the day → WAIT.
  if (onBed && (night || exhausted)) {
    if (night && can("SLEEP")) {
      return act("SLEEP", "In bed at night. Time to sleep.", "Good night.");
    }
    if (can("WAIT")) {
      return act("WAIT", "Spent, but it is not night yet — resting at bed.", "So tired...");
    }
  }

  // 7. out of seeds and gold >= a seed cost → MOVE_TO(shop) then BUY.
  //    Skipped at energy 0: kickoff energy rule allows only MOVE_TO(bed)/WAIT.
  if (!exhausted && seeds.length === 0 && self.gold >= CROPS.parsnip.seedCost) {
    const cost = CROPS.parsnip.seedCost;
    if (atShop && can("BUY")) {
      const qty = Math.max(1, Math.min(3, Math.floor(self.gold / cost)));
      return act(
        "BUY",
        `No seeds left and ${self.gold}g on hand — buying ${qty} parsnip seeds.`,
        "Parsnip seeds, please!",
        { itemId: "seed:parsnip", qty },
      );
    }
    if (shop && can("MOVE_TO") && !samePos(pos, shop)) {
      return moveTo(shop, "Out of seeds — off to the shop.");
    }
  }

  // 8. otherwise → MOVE_TO the nearest actionable destination. At night or
  //    at energy 0 the destination is the bed (so step 6 becomes reachable);
  //    otherwise: untilled soil → tilled empty → unwatered crop → ready crop,
  //    whichever is closest (category order breaks distance ties).
  if (can("MOVE_TO")) {
    if ((night || exhausted) && bed && !samePos(pos, bed)) {
      return moveTo(
        bed,
        night ? "It is night — heading to bed." : "Exhausted — walking to bed.",
        exhausted ? "So tired..." : null,
      );
    }
    type Candidate = { x: number; y: number; cat: number };
    const candidates: Candidate[] = [
      ...(self.energy > 0 ? tillable.map((t) => ({ x: t.x, y: t.y, cat: 0 })) : []),
      ...(seeds.length > 0 ? tilledEmpty.map((t) => ({ x: t.x, y: t.y, cat: 1 })) : []),
      ...(self.energy > 0 && !recklessSkip
        ? thirstyCrops.map((t) => ({ x: t.x, y: t.y, cat: 2 }))
        : []),
      ...readyCrops.map((t) => ({ x: t.x, y: t.y, cat: 3 })),
    ].filter((t) => !isAdjacent(pos, t)); // adjacent+actionable was handled in steps 1-5
    if (candidates.length > 0) {
      const dest = [...candidates].sort(
        (p, q) => cheb(pos, p) - cheb(pos, q) || p.cat - q.cat || p.y - q.y || p.x - q.x,
      )[0];
      return moveTo(dest, `Heading to the field work at (${dest.x},${dest.y}).`);
    }
  }

  // Persona flavor (secondary, after the ladder): social agents may chat
  // instead of idling when someone is within 1 tile.
  if (persona.includes("social") && can("TALK_TO") && seed % 3 === 0) {
    const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
    if (neighbor) {
      return act(
        "TALK_TO",
        `Nothing pressing, and ${neighbor.name} is right here — chat time.`,
        `Hey ${neighbor.name}! How's the farm?`,
        { agentName: neighbor.name },
      );
    }
  }

  // 9. otherwise → WAIT
  return act("WAIT", "Nothing pressing right now. Taking a breather.", null);
}

export const mockRouter: Router = async (req): Promise<LlmResponse> => {
  const latencyMs = hash(req.user) % 6; // deterministic 0-5

  let obs: Observation | null = null;
  const json = extractFirstJsonObject(req.user);
  if (json !== null) {
    try {
      obs = JSON.parse(json) as Observation;
    } catch {
      obs = null;
    }
  }

  const action: AgentAction = obs
    ? decide(obs)
    : {
        thought: "Could not read the observation — waiting.",
        say: null,
        action: "WAIT",
      };

  return {
    raw: JSON.stringify(action),
    parsed: action,
    model: "mock",
    latencyMs,
  };
};
