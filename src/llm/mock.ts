/**
 * mockRouter — deterministic heuristic farmer (§11). $0, model:"mock",
 * latencyMs 0-5. Parses the Observation embedded in req.user (the user
 * prompt is JSON.stringify(observation) + a trailing question) and returns
 * a valid AgentAction that competently plays the farm loop:
 * till -> plant -> water -> sleep -> harvest -> sell, buying seeds when out.
 *
 * Deterministic: no Math.random — persona flavor uses a hash of
 * (agentName + day) so runs replay identically.
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

/** Core heuristic — priority-ordered, always respects obs.availableActions. */
function decide(obs: Observation): AgentAction {
  const self = obs.self;
  const pos = self.pos;
  const persona = self.persona.toLowerCase();
  const seed = hash(`${self.name}:${obs.time.day}`);
  const can = (a: ActionType) => obs.availableActions.includes(a);

  const bed = findLandmark(obs, "bed");
  const shop = findLandmark(obs, "shop");
  const atShop = shop !== null && isAdjacent(pos, shop);

  const seeds = self.inventory.filter((i) => i.itemId.startsWith("seed:") && i.qty > 0);
  const crops = self.inventory.filter((i) => i.itemId.startsWith("crop:") && i.qty > 0);

  const tiles = obs.nearby.tiles;
  const readyCrops = tiles.filter((t) => t.crop?.ready);
  const thirstyCrops = tiles.filter((t) => t.crop && !t.crop.watered && !t.crop.ready);
  const tilledEmpty = tiles.filter((t) => t.type === "tilled" && !t.crop);
  const tillable = tiles.filter(
    (t) => (t.type === "soil" || t.type === "grass") && !t.crop && !samePos(t, pos),
  );
  const tilledCount = tiles.filter((t) => t.type === "tilled").length;

  // 1-2. Night: sleep at the bed, or head there.
  if (obs.time.phase === "night") {
    if (bed && isAdjacent(pos, bed) && can("SLEEP")) {
      return act("SLEEP", "It is night and I am at my bed. Time to sleep.", "Good night.");
    }
    if (bed && can("MOVE_TO") && !samePos(pos, bed)) {
      return moveTo(bed, "It is night — heading to bed.");
    }
  }

  // 3. Critically low energy: retreat to bed (or just wait it out).
  if (self.energy <= 2) {
    if (bed && can("MOVE_TO") && !samePos(pos, bed)) {
      return moveTo(bed, "I am exhausted — walking to bed.", "So tired...");
    }
    if (can("WAIT")) {
      return act("WAIT", "Too exhausted to work. Resting in place.", null);
    }
  }

  // Persona flavor: social agents sometimes chat with whoever is beside them.
  if (persona.includes("social") && can("TALK_TO") && seed % 3 === 0) {
    const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
    if (neighbor) {
      return act(
        "TALK_TO",
        `${neighbor.name} is right here — a chat beats chores.`,
        `Hey ${neighbor.name}! How's the farm?`,
        { agentName: neighbor.name },
      );
    }
  }

  // 4. Ready crop: harvest it (adjacent) or walk to it.
  const ready = nearest(pos, readyCrops);
  if (ready) {
    if (isAdjacent(pos, ready) && can("HARVEST")) {
      return act(
        "HARVEST",
        `The ${ready.crop?.kind ?? "crop"} at (${ready.x},${ready.y}) is ready.`,
        "Harvest time!",
        { x: ready.x, y: ready.y },
      );
    }
    if (can("MOVE_TO") && !samePos(pos, ready)) {
      return moveTo(ready, `Heading to the ready crop at (${ready.x},${ready.y}).`);
    }
  }

  // 5. Unwatered crop: water it — unless a reckless mood strikes (30%,
  // deterministic by name+day).
  const recklessSkip = persona.includes("reckless") && seed % 10 < 3;
  const thirsty = nearest(pos, thirstyCrops);
  if (thirsty && !recklessSkip) {
    if (isAdjacent(pos, thirsty) && can("WATER")) {
      return act(
        "WATER",
        `The ${thirsty.crop?.kind ?? "crop"} at (${thirsty.x},${thirsty.y}) needs water.`,
        null,
        { x: thirsty.x, y: thirsty.y },
      );
    }
    if (can("MOVE_TO") && !samePos(pos, thirsty)) {
      return moveTo(thirsty, `Going to water the crop at (${thirsty.x},${thirsty.y}).`);
    }
  }

  // 6. Seeds in pocket + tilled empty soil: plant (or walk to the plot).
  if (seeds.length > 0) {
    const plot = nearest(pos, tilledEmpty);
    if (plot) {
      if (isAdjacent(pos, plot) && can("PLANT")) {
        return act(
          "PLANT",
          `Planting ${seeds[0].itemId} in the tilled plot at (${plot.x},${plot.y}).`,
          null,
          { x: plot.x, y: plot.y },
        );
      }
      if (can("MOVE_TO") && !samePos(pos, plot)) {
        return moveTo(plot, `Carrying seeds to the tilled plot at (${plot.x},${plot.y}).`);
      }
    }
  }

  // 7. Expand the field a little: till adjacent soil/grass while plots are few.
  if (tilledCount < 6 && can("TILL")) {
    const spot = nearest(
      pos,
      tillable.filter((t) => isAdjacent(pos, t)),
    );
    if (spot) {
      return act(
        "TILL",
        `Only ${tilledCount} tilled plots nearby — tilling (${spot.x},${spot.y}).`,
        null,
        { x: spot.x, y: spot.y },
      );
    }
  }

  // 8-9. Harvested goods: sell at the shop, or carry them there.
  if (crops.length > 0) {
    if (atShop && can("SELL")) {
      const lot = crops[0];
      return act(
        "SELL",
        `Selling all ${lot.qty} ${lot.itemId} at the shop.`,
        "Fresh produce, straight from the field!",
        { itemId: lot.itemId, qty: lot.qty },
      );
    }
    if (shop && can("MOVE_TO") && !samePos(pos, shop)) {
      return moveTo(shop, "Hauling my harvest to the shop to sell.");
    }
  }

  // 10-11. Out of seeds: buy parsnips at the shop, or walk to the shop.
  if (seeds.length === 0) {
    const cost = CROPS.parsnip.seedCost;
    if (self.gold >= cost && atShop && can("BUY")) {
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

  // 12. Nothing useful to do.
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
