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
 *
 * THROW-PROOF (QE hardening): mockRouter is the budget-ceiling fallback
 * safety net, so it must never reject. Any object input is normalized into
 * a safe Observation (missing fields default to empty/zero), decide() is
 * belt-and-braces wrapped, and unreadable input degrades to WAIT.
 */
import type {
  ActionType,
  AgentAction,
  LlmResponse,
  Observation,
  PlanStep,
  Router,
  Vec2,
} from "@contracts/types";
import { CROPS } from "@contracts/types";
import { extractFirstJsonObject } from "./parse";

const ACTION_TYPES: readonly ActionType[] = [
  "MOVE_TO",
  "TILL",
  "PLANT",
  "WATER",
  "HARVEST",
  "BUY",
  "SELL",
  "TALK_TO",
  "GIVE_GIFT", // v2 — accepted in availableActions; the heuristic never emits it
  "EMOTE", // v2 — accepted in availableActions; the heuristic never emits it
  "SLEEP",
  "WAIT",
];

const PHASES = ["morning", "afternoon", "evening", "night"] as const;

function asString(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt;
}

function asFiniteNumber(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asVec2(v: unknown): Vec2 | null {
  const r = asRecord(v);
  return typeof r.x === "number" &&
    Number.isFinite(r.x) &&
    typeof r.y === "number" &&
    Number.isFinite(r.y)
    ? { x: r.x, y: r.y }
    : null;
}

/**
 * Coerce ANY parsed JSON value into a safe Observation, defaulting missing
 * or malformed fields (QE finding: a parseable-but-partial observation made
 * decide() throw). Missing energy defaults to 0 and missing availableActions
 * to [] — both conservative: the ladder then bottoms out at WAIT. Returns
 * null only when the input is not a plain object at all.
 */
function normalizeObservation(raw: unknown): Observation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const self = asRecord(o.self);
  const time = asRecord(o.time);
  const nearby = asRecord(o.nearby);

  const inventory = asArray(self.inventory).flatMap((e) => {
    const it = asRecord(e);
    return typeof it.itemId === "string" && typeof it.qty === "number" && Number.isFinite(it.qty)
      ? [{ itemId: it.itemId, qty: it.qty }]
      : [];
  });

  const tiles = asArray(nearby.tiles).flatMap((e) => {
    const t = asRecord(e);
    if (
      typeof t.x !== "number" ||
      !Number.isFinite(t.x) ||
      typeof t.y !== "number" ||
      !Number.isFinite(t.y)
    ) {
      return [];
    }
    const cropRec = typeof t.crop === "object" && t.crop !== null ? asRecord(t.crop) : null;
    const crop = cropRec
      ? {
          kind: asString(cropRec.kind, "parsnip"),
          stage: asFiniteNumber(cropRec.stage, 0),
          watered: Boolean(cropRec.watered),
          ready: Boolean(cropRec.ready),
        }
      : undefined;
    const tile: Observation["nearby"]["tiles"][number] = {
      x: t.x,
      y: t.y,
      type: asString(t.type, "grass") as Observation["nearby"]["tiles"][number]["type"],
    };
    if (crop) tile.crop = crop;
    return [tile];
  });

  const agents = asArray(nearby.agents).flatMap((e) => {
    const a = asRecord(e);
    const pos = asVec2(a.pos);
    return typeof a.name === "string" && pos
      ? [{ name: a.name, pos, lastSeenDoing: asString(a.lastSeenDoing, "") }]
      : [];
  });

  const landmarks = asArray(nearby.landmarks).flatMap((e) => {
    const l = asRecord(e);
    const pos = asVec2(l.pos);
    const kind = l.kind;
    return pos && (kind === "shop" || kind === "bed" || kind === "water" || kind === "house")
      ? [{ kind: kind as "shop" | "bed" | "water" | "house", pos }]
      : [];
  });

  const phase = (PHASES as readonly string[]).includes(time.phase as string)
    ? (time.phase as Observation["time"]["phase"])
    : "morning";

  return {
    self: {
      name: asString(self.name, "unknown"),
      persona: asString(self.persona, ""),
      role: asString(self.role, "farmer"),
      pos: asVec2(self.pos) ?? { x: 0, y: 0 },
      energy: asFiniteNumber(self.energy, 0),
      gold: asFiniteNumber(self.gold, 0),
      inventory,
      goal: typeof self.goal === "string" ? self.goal : null,
    },
    time: { day: asFiniteNumber(time.day, 1), phase },
    nearby: { tiles, agents, landmarks },
    lastAction: null, // unused by the heuristic
    availableActions: asArray(o.availableActions).filter((a): a is ActionType =>
      (ACTION_TYPES as readonly unknown[]).includes(a),
    ),
    economy: { sells: {}, buys: {} }, // unused by the heuristic (CROPS is authoritative)
  };
}

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

const UNREADABLE_WAIT: AgentAction = {
  thought: "observation unreadable",
  say: null,
  action: "WAIT",
};

export const mockRouter: Router = async (req): Promise<LlmResponse> => {
  const latencyMs = hash(req.user) % 6; // deterministic 0-5

  let obs: Observation | null = null;
  try {
    const json = extractFirstJsonObject(req.user);
    if (json !== null) {
      obs = normalizeObservation(JSON.parse(json));
    }
  } catch {
    obs = null;
  }

  let action: AgentAction;
  if (obs) {
    try {
      action = decide(obs);
    } catch {
      // Belt-and-braces: the normalizer should make this unreachable, but
      // the budget-fallback net must never reject (QE hardening).
      action = UNREADABLE_WAIT;
    }
  } else {
    action = UNREADABLE_WAIT;
  }

  return {
    raw: JSON.stringify(action),
    parsed: action,
    model: "mock",
    latencyMs,
  };
};

// ---------------------------------------------------------------------------
// v2 — mock cognition counterparts (deterministic, $0). The cognition-agent
// uses these whenever the live route is unavailable (contracts rules 9/11/12:
// the whole pipeline must be testable with the server down).
// ---------------------------------------------------------------------------

/**
 * Heuristic 1–10 poignancy rating per contracts/README.md rule 9:
 * gift/harvest-fail 7, talk 5, routine farm action 2. Unclassified memory
 * text defaults to 3 (rule 9 only pins those three classes; 3 keeps unknown
 * events slightly above confirmed routine without ever triggering
 * reflection storms). Deterministic, never throws.
 */
export function rateImportanceMock(text: string): number {
  const t = typeof text === "string" ? text.toLowerCase() : "";
  if (t.includes("gift") || t.includes("gave") || t.includes("received")) return 7;
  if (t.includes("harvest") && (t.includes("fail") || t.includes("reject") || t.includes("ruin"))) {
    return 7;
  }
  if (t.includes("talk") || t.includes("said") || t.includes("chat") || t.includes("told")) {
    return 5;
  }
  if (/\b(till|tilled|plant|planted|water|watered|harvest|harvested|buy|bought|sell|sold|sleep|slept|moved|walk)\b/.test(t)) {
    return 2;
  }
  return 3;
}

/**
 * Templated reflection (rule 11 mock path): one insight memory text citing
 * the source memory ids it was "inferred" from (cap 5, like the live
 * insights prompt). Deterministic — same inputs, same reflection.
 */
export function mockReflection(
  agentName: string,
  memories: { id: string; text: string }[],
): { text: string; sourceIds: string[] } {
  const cited = memories.slice(0, 5);
  if (cited.length === 0) {
    return {
      text: `${agentName} reflects: the days have been quiet, with nothing standing out.`,
      sourceIds: [],
    };
  }
  const gist = cited[hash(agentName + cited[0].id) % cited.length].text.replace(/[.\s]+$/, "");
  return {
    text: `${agentName} reflects: looking back over ${cited.length} recent moments, what stands out is "${gist}" — it is shaping how the days are going.`,
    sourceIds: cited.map((m) => m.id),
  };
}

/**
 * Sensible deterministic 4-step farm plan (rule 12 mock path): one step per
 * phase, night always ends at the bed. Persona keywords add light flavor
 * (social → evening chat at the shop; reckless → looser morning). rawText
 * mirrors what a live model would have returned, for the inspector.
 */
export function mockDailyPlan(
  persona: string,
  day: number,
): { steps: PlanStep[]; rawText: string } {
  const p = (persona ?? "").toLowerCase();
  const social = p.includes("social");
  const reckless = p.includes("reckless");

  const steps: PlanStep[] = [
    {
      phase: "morning",
      goal: reckless
        ? `day ${day}: charge into the field — till and plant whatever looks promising`
        : `day ${day}: water every planted crop, then till and plant free plots`,
      done: false,
    },
    {
      phase: "afternoon",
      goal:
        day % 2 === 0
          ? "harvest anything ready and keep the plots tended"
          : "tend the crops and till new ground for the next planting",
      done: false,
    },
    {
      phase: "evening",
      goal: social
        ? "swing by the shop to sell, and catch up with whoever is around"
        : "sell harvested crops and restock seeds at the shop",
      targetLandmark: "shop",
      done: false,
    },
    {
      phase: "night",
      goal: "head home to bed and sleep",
      targetLandmark: "bed",
      done: false,
    },
  ];

  return {
    steps,
    rawText: JSON.stringify({
      steps: steps.map(({ phase, goal, targetLandmark }) =>
        targetLandmark ? { phase, goal, targetLandmark } : { phase, goal },
      ),
    }),
  };
}
