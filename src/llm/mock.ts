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
 * Plan-intent follower (v4): when obs.self.currentPlanStep contains leisure
 * keywords (tavern/socialize/pond/relax/market/shop/rest/home), the agent
 * heads toward the matching landmark or emotes/waits there. This fires AFTER
 * the event ATTEND/INVITE branches (priority-safe) but BEFORE the farm
 * ladder, so leisure activities interleave naturally: farm work still happens
 * whenever the plan step is farm-flavored.
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
  Landmark,
  LlmResponse,
  NeedState,
  Observation,
  Phase,
  PlanStep,
  Router,
  SimEvent,
  Vec2,
  WorldObject,
} from "@contracts/types";
import { CROPS } from "@contracts/types";
import { extractFirstJsonObject } from "./parse";
import { FUNCTIONAL_STEP_TEXT, preferredLocation } from "../agents/locations";

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
  "USE_OBJECT", // v3 — heuristic emits when adjacent + plan calls for it
  "VOTE", // Wave 4c — heuristic emits when enrichObservation injected it (aware + unvoted)
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

  // Wave 5b — admit ALL 8 landmark kinds (5a left cafe/office/park inert here).
  // Frozen-safe: a landmark is INERT to the heuristic unless a plan-step keyword
  // targets it, and no existing branch references cafe/office/park — only the
  // new Wave-5b functional branches do (mock-determinism / economy unaffected).
  const landmarks = asArray(nearby.landmarks).flatMap((e) => {
    const l = asRecord(e);
    const pos = asVec2(l.pos);
    const kind = l.kind;
    return pos &&
      (kind === "shop" ||
        kind === "bed" ||
        kind === "water" ||
        kind === "house" ||
        kind === "tavern" ||
        kind === "cafe" ||
        kind === "office" ||
        kind === "park")
      ? [{ kind: kind as Landmark["kind"], pos }]
      : [];
  });

  const phase = (PHASES as readonly string[]).includes(time.phase as string)
    ? (time.phase as Observation["time"]["phase"])
    : "morning";

  // v3 — preserve knownEvents (SimEvent & { isNow }) pass-through
  const knownEvents = asArray(self.knownEvents).flatMap((e) => {
    const ev = asRecord(e);
    const loc = asVec2(ev.location);
    const evPhase = (PHASES as readonly string[]).includes(ev.phase as string)
      ? (ev.phase as Phase)
      : null;
    if (typeof ev.id !== "string" || typeof ev.host !== "string" || !loc || !evPhase) return [];
    const se: SimEvent & { isNow: boolean } = {
      id: ev.id,
      host: ev.host,
      location: loc,
      day: asFiniteNumber(ev.day, 1),
      phase: evPhase,
      description: asString(ev.description, ""),
      isNow: Boolean(ev.isNow),
    };
    return [se];
  });

  // v3 — preserve inviteTargets pass-through
  const inviteTargets = asArray(self.inviteTargets).flatMap((e) => {
    const it = asRecord(e);
    const pos = asVec2(it.pos);
    return typeof it.name === "string" && pos ? [{ name: it.name, pos }] : [];
  });

  // Wave 4c — preserve activeProposal pass-through (defensive: all fields typed).
  const apRec = asRecord(self.activeProposal);
  const activeProposal =
    typeof apRec.id === "string" &&
    typeof apRec.proposer === "string" &&
    typeof apRec.ruleText === "string"
      ? {
          id: apRec.id,
          proposer: apRec.proposer,
          ruleText: apRec.ruleText,
          day: asFiniteNumber(apRec.day, 1),
          awareCount: asFiniteNumber(apRec.awareCount, 0),
          yes: asFiniteNumber(apRec.yes, 0),
          no: asFiniteNumber(apRec.no, 0),
        }
      : null;

  const selfOut: Observation["self"] = {
    name: asString(self.name, "unknown"),
    persona: asString(self.persona, ""),
    role: asString(self.role, "farmer"),
    pos: asVec2(self.pos) ?? { x: 0, y: 0 },
    energy: asFiniteNumber(self.energy, 0),
    gold: asFiniteNumber(self.gold, 0),
    inventory,
    goal: typeof self.goal === "string" ? self.goal : null,
  };
  // Wave 3a — defensive needs round-trip: parse all 5 numerics, clamp to
  // [0,1], and attach only when ALL five are present & finite.
  const needsRec = asRecord(self.needs);
  const needKeys = ["energy", "wealth", "social", "novelty", "purpose"] as const;
  if (needKeys.every((k) => typeof needsRec[k] === "number" && Number.isFinite(needsRec[k]))) {
    const clampNeed = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    selfOut.needs = {
      energy: clampNeed(needsRec.energy as number),
      wealth: clampNeed(needsRec.wealth as number),
      social: clampNeed(needsRec.social as number),
      novelty: clampNeed(needsRec.novelty as number),
      purpose: clampNeed(needsRec.purpose as number),
    };
  }
  // v4 — preserve currentPlanStep for plan-intent follower in decide()
  if (typeof self.currentPlanStep === "string") {
    selfOut.currentPlanStep = self.currentPlanStep;
  } else if (self.currentPlanStep === null) {
    selfOut.currentPlanStep = null;
  }
  if (knownEvents.length > 0) selfOut.knownEvents = knownEvents;
  if (inviteTargets.length > 0) selfOut.inviteTargets = inviteTargets;
  // Wave 4c — governance surface pass-through.
  if (activeProposal) selfOut.activeProposal = activeProposal;
  if (typeof self.myVote === "boolean") selfOut.myVote = self.myVote;
  // Wave 4c — relationships pass-through (affinity bias for the VOTE branch).
  // Defensive: keep only well-shaped {name, affinity} rows.
  const relationships = asArray(self.relationships).flatMap((e) => {
    const r = asRecord(e);
    return typeof r.name === "string" &&
      typeof r.affinity === "number" &&
      Number.isFinite(r.affinity)
      ? [{ name: r.name, affinity: r.affinity }]
      : [];
  });
  if (relationships.length > 0) selfOut.relationships = relationships;

  // v3 — parse nearby.objects (well / notice_board / bench pass-through)
  const nearbyObjects = asArray(nearby.objects).flatMap((e) => {
    const ob = asRecord(e);
    const pos = asVec2(ob.pos);
    const kind = ob.kind;
    return pos &&
      typeof ob.id === "string" &&
      (kind === "well" || kind === "notice_board" || kind === "bench")
      ? [{ id: ob.id as string, kind: kind as WorldObject["kind"], pos }]
      : [];
  });

  const nearbyOut: Observation["nearby"] = { tiles, agents, landmarks };
  if (nearbyObjects.length > 0) nearbyOut.objects = nearbyObjects;

  return {
    self: selfOut,
    time: { day: asFiniteNumber(time.day, 1), phase },
    nearby: nearbyOut,
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

  // v3 — event-driven branches (evaluated before farm ladder)
  const events = self.knownEvents ?? [];
  const nowEvent = events.find((e) => e.isNow);
  const invites = self.inviteTargets ?? [];

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

  // v3-A. ATTEND (highest priority): if an event is happening now, go to it
  if (nowEvent) {
    if (isAdjacent(pos, nowEvent.location) || samePos(pos, nowEvent.location)) {
      // Already at the event — emote happy or wait
      if (can("EMOTE")) {
        return {
          action: "EMOTE",
          thought: "Enjoying the gathering at the tavern.",
          say: "What a lovely gathering!",
          emotion: "happy",
        };
      }
      return act("WAIT", "Enjoying the gathering at the tavern.", "What a lovely gathering!");
    }
    if (can("MOVE_TO")) {
      return moveTo(nowEvent.location, "Heading to the gathering at the tavern.");
    }
  }

  // v3-B. HOST INVITE (high priority): if I'm the host and people haven't heard yet
  if (!nowEvent && invites.length > 0) {
    const target = nearest(pos, invites.map((i) => ({ x: i.pos.x, y: i.pos.y, name: i.name })));
    if (target) {
      const targetPos: Vec2 = { x: target.x, y: target.y };
      if (cheb(pos, targetPos) <= 1) {
        if (can("TALK_TO")) {
          return act(
            "TALK_TO",
            `I should invite ${target.name} to my gathering.`,
            "Come to my gathering at the tavern this evening!",
            { agentName: target.name },
          );
        }
      } else if (can("MOVE_TO")) {
        return moveTo(targetPos, `Off to invite ${target.name} to the gathering.`);
      }
    }
  }

  // Wave 4c. VOTE: when enrichObservation injected VOTE (the agent is aware of
  // an open proposal and has NOT voted), cast a deterministic ballot. Fires
  // after the event ATTEND/INVITE branches (so a live gathering still wins) but
  // before the plan-follower + farm ladder, so civic duty is not starved.
  // Support = hash(name + proposalId) % 2 === 0, biased by affinity to the
  // proposer (affinity >= 0 → lean yes). PURE — no RNG, no Date.now.
  if (can("VOTE") && self.activeProposal) {
    const ap = self.activeProposal;
    let support = hash(`${self.name}${ap.id}`) % 2 === 0;
    const rel = (self.relationships ?? []).find((r) => r.name === ap.proposer);
    if (rel) support = rel.affinity >= 0; // affinity sign overrides the hash coin-flip
    return act(
      "VOTE",
      `The town is deciding on a rule: "${ap.ruleText}". I'll cast my vote.`,
      support ? "I'm for the new rule." : "I can't back that rule.",
      { proposalId: ap.id, support },
    );
  }

  // Wave 4c. PROPOSAL SPREAD: an agent AWARE of the open proposal (it surfaces
  // on the obs only for knowers) talks it up to an already-adjacent neighbor so
  // word diffuses. Mirrors the v3-C event spread: it is DISPERSIVE (chat in
  // place, no movement toward anyone), so the party kill-switch stays intact.
  // Fires after VOTE (so the agent votes first when it still can) but before the
  // farm ladder, so civic word actually spreads instead of being starved.
  if (self.activeProposal && can("TALK_TO")) {
    const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
    if (neighbor) {
      return act(
        "TALK_TO",
        `${neighbor.name} should hear about the town rule we're voting on.`,
        `Have you heard? There's a town rule up for a vote.`,
        { agentName: neighbor.name },
      );
    }
  }

  // v4-C. PLAN-INTENT FOLLOWER: when the current plan step contains leisure
  // keywords, head to the matching landmark and act there. This fires AFTER
  // the event ATTEND/INVITE branches so those keep their priority, but BEFORE
  // the farm ladder so leisure actually happens instead of being starved.
  // Only fires when there is an explicit plan step (defensive: no step → skip).
  const planStep = (obs.self.currentPlanStep ?? "").toLowerCase();
  if (planStep.length > 0) {
    // --- TAVERN / SOCIAL branch ---
    const tavernIntent =
      planStep.includes("tavern") ||
      planStep.includes("sociali") ||
      planStep.includes("chat") ||
      planStep.includes("gather");
    if (tavernIntent) {
      const tavernLm = obs.nearby.landmarks.find((l) => l.kind === "tavern");
      if (tavernLm) {
        if (isAdjacent(pos, tavernLm.pos) || samePos(pos, tavernLm.pos)) {
          // Already there — chat with a neighbor or mingle
          const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
          if (neighbor && can("TALK_TO")) {
            return act(
              "TALK_TO",
              `Plan says to socialize. ${neighbor.name} is right here at the tavern!`,
              `${neighbor.name}! Good to see you here.`,
              { agentName: neighbor.name },
            );
          }
          if (can("EMOTE")) {
            return {
              action: "EMOTE",
              thought: "Enjoying the social atmosphere at the tavern.",
              say: "What a fine day to be out!",
              emotion: "happy",
            };
          }
          return act("WAIT", "Mingling at the tavern.", "Anyone up for a chat?");
        }
        if (can("MOVE_TO")) {
          return moveTo(tavernLm.pos, "Plan says socialize — heading to the tavern.");
        }
      }
    }

    // --- POND / RELAX branch ---
    const pondIntent =
      planStep.includes("pond") ||
      planStep.includes("relax") ||
      planStep.includes("reflect") ||
      planStep.includes("stroll") ||
      planStep.includes("walk") ||
      planStep.includes("wander");
    if (pondIntent) {
      const waterLm = obs.nearby.landmarks.find((l) => l.kind === "water");
      if (waterLm) {
        if (isAdjacent(pos, waterLm.pos) || samePos(pos, waterLm.pos)) {
          if (can("EMOTE")) {
            return {
              action: "EMOTE",
              thought: "Sitting by the pond, at peace.",
              say: "So still. So quiet.",
              emotion: "happy",
            };
          }
          return act("WAIT", "Relaxing by the pond.", "The water is so calm.");
        }
        if (can("MOVE_TO")) {
          return moveTo(waterLm.pos, "Plan says relax — heading to the pond.");
        }
      }
    }

    // --- MARKET / SHOP branch ---
    const marketIntent =
      planStep.includes("market") ||
      planStep.includes("browse") ||
      planStep.includes("haggle") ||
      planStep.includes("price");
    if (marketIntent) {
      // Reuse the existing shop variable; fall through to the farm ladder's
      // shop logic if we're already there (it handles BUY/SELL correctly).
      if (shop && !samePos(pos, shop) && !atShop && can("MOVE_TO")) {
        return moveTo(shop, "Plan says browse the market — heading to the shop.");
      }
      // At the shop: fall through to farm ladder steps 2 & 7 (SELL/BUY).
    }

    // --- REST / HOME branch ---
    const restIntent =
      planStep.includes("rest") ||
      planStep.includes("home") ||
      (planStep.includes("sleep") && !night); // "sleep" at night handled by step 6
    if (restIntent && !night && !exhausted) {
      if (bed) {
        if (onBed) {
          return act("WAIT", "Resting at home as planned.", null);
        }
        if (can("MOVE_TO")) {
          return moveTo(bed, "Plan says rest — heading home.");
        }
      }
    }

    // --- CAFE branch (Wave 5b functional locations) ---
    // Socialite routine: coffee + catching up. DISPERSIVE — the TALK_TO fires
    // ONLY for an ALREADY-ADJACENT neighbor (no move-to-converge), so this never
    // creates a new convergence point that could undermine the party kill-switch.
    const cafeIntent = planStep.includes("cafe") || planStep.includes("coffee");
    if (cafeIntent) {
      const cafeLm = obs.nearby.landmarks.find((l) => l.kind === "cafe");
      if (cafeLm) {
        if (isAdjacent(pos, cafeLm.pos) || samePos(pos, cafeLm.pos)) {
          const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
          if (neighbor && can("TALK_TO")) {
            return act(
              "TALK_TO",
              `Coffee at the cafe — ${neighbor.name} is right here, time to catch up.`,
              `${neighbor.name}! Care to share a cup?`,
              { agentName: neighbor.name },
            );
          }
          if (can("EMOTE")) {
            return {
              action: "EMOTE",
              thought: "Enjoying a quiet coffee at the cafe.",
              say: "Nothing like a good cup.",
              emotion: "happy",
            };
          }
          return act("WAIT", "Sipping coffee at the cafe.", "A fine brew today.");
        }
        if (can("MOVE_TO")) {
          return moveTo(cafeLm.pos, "Plan says coffee — heading to the cafe.");
        }
      }
    }

    // --- OFFICE branch (Wave 5b functional locations) ---
    // Banker routine: working the ledgers. DISPERSIVE — EMOTE/WAIT in place, no
    // movement toward anyone (kill-switch safe).
    const officeIntent =
      planStep.includes("office") ||
      planStep.includes("ledger") ||
      planStep.includes("paperwork");
    if (officeIntent) {
      const officeLm = obs.nearby.landmarks.find((l) => l.kind === "office");
      if (officeLm) {
        if (isAdjacent(pos, officeLm.pos) || samePos(pos, officeLm.pos)) {
          if (can("EMOTE")) {
            return {
              action: "EMOTE",
              thought: "Hard at work at the office.",
              say: "The ledgers won't balance themselves.",
              emotion: "neutral",
            };
          }
          return act("WAIT", "Working at the office.", "Back to the ledgers.");
        }
        if (can("MOVE_TO")) {
          return moveTo(officeLm.pos, "Plan says work — heading to the office.");
        }
      }
    }

    // --- PARK branch (Wave 5b functional locations) ---
    // Wanderer routine: fresh air in the green. DISPERSIVE — EMOTE/WAIT in place
    // (kill-switch safe).
    const parkIntent =
      planStep.includes("park") ||
      planStep.includes("fresh air") ||
      planStep.includes("green");
    if (parkIntent) {
      const parkLm = obs.nearby.landmarks.find((l) => l.kind === "park");
      if (parkLm) {
        if (isAdjacent(pos, parkLm.pos) || samePos(pos, parkLm.pos)) {
          if (can("EMOTE")) {
            return {
              action: "EMOTE",
              thought: "Out in the park, taking in the fresh air.",
              say: "What a lovely spot.",
              emotion: "happy",
            };
          }
          return act("WAIT", "Strolling in the park.", "So peaceful out here.");
        }
        if (can("MOVE_TO")) {
          return moveTo(parkLm.pos, "Plan says fresh air — heading to the park.");
        }
      }
    }
  }
  // end plan-intent follower — fall through to the farm ladder below

  // v3-D. OBJECT AFFORDANCES: use nearby world objects when relevant.
  // Priority: plan-guided > opportunistic notice-board diffusion > farm ladder.
  // Does not dominate farming: only fires when a plan step references the object
  // OR when the notice board is adjacent and there is an unread active event.
  if (can("USE_OBJECT")) {
    const objects = obs.nearby.objects ?? [];

    // Plan-guided: "draw water" / "well" → use the well.
    const wellIntent =
      planStep.includes("draw water") ||
      planStep.includes("well") ||
      planStep.includes("fetch water");
    if (wellIntent) {
      const well = objects.find((o) => o.kind === "well");
      if (well) {
        if (isAdjacent(pos, well.pos) || samePos(pos, well.pos)) {
          return act("USE_OBJECT", "Drawing water at the well as planned.", null, { objectId: well.id });
        }
        if (can("MOVE_TO")) {
          return moveTo(well.pos, "Heading to the well to draw water.");
        }
      }
    }

    // Plan-guided: "read" / "notice board" / "news" → use the notice board.
    const boardIntent =
      planStep.includes("notice board") ||
      planStep.includes("read") ||
      planStep.includes("news") ||
      planStep.includes("announcement");
    if (boardIntent) {
      const board = objects.find((o) => o.kind === "notice_board");
      if (board) {
        if (isAdjacent(pos, board.pos) || samePos(pos, board.pos)) {
          return act("USE_OBJECT", "Reading the town notice board as planned.", null, { objectId: board.id });
        }
        if (can("MOVE_TO")) {
          return moveTo(board.pos, "Heading to the notice board to read the news.");
        }
      }
    }

    // Plan-guided: "rest" / "bench" (when not already heading home) → use bench.
    const benchIntent =
      planStep.includes("bench") ||
      (planStep.includes("rest") && !planStep.includes("home") && !planStep.includes("bed"));
    if (benchIntent) {
      const bench = objects.find((o) => o.kind === "bench");
      if (bench) {
        if (isAdjacent(pos, bench.pos) || samePos(pos, bench.pos)) {
          return act("USE_OBJECT", "Resting on the bench as planned.", null, { objectId: bench.id });
        }
        if (can("MOVE_TO")) {
          return moveTo(bench.pos, "Heading to the bench to rest.");
        }
      }
    }

    // Opportunistic: if adjacent to the notice board and there are known events
    // that might be unread, check the board. Keep it rare (hash-gated) so it
    // doesn't dominate normal behavior.
    const board = objects.find((o) => o.kind === "notice_board");
    if (board && (isAdjacent(pos, board.pos) || samePos(pos, board.pos)) && seed % 5 === 0) {
      return act("USE_OBJECT", "I'm right by the notice board — might as well read it.", null, { objectId: board.id });
    }
  }

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

  // v3-C. OPPORTUNISTIC SPREAD (low priority): any knower adjacent to someone
  // spreads the news — drives multi-hop diffusion even for non-hosts.
  if (events.length > 0 && can("TALK_TO")) {
    const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
    if (neighbor) {
      return act(
        "TALK_TO",
        `I know about the gathering — ${neighbor.name} should hear about it.`,
        "Come to my gathering at the tavern this evening!",
        { agentName: neighbor.name },
      );
    }
  }

  // Wave 4a — EMERGENT ROLE BIAS (lowest priority, only when nothing pressing).
  // Gated on a non-default role so default-role agents stay byte-identical.
  // Every nudge is DISPERSIVE or shop-only — NONE target the tavern or move an
  // agent toward another, so the party kill-switch stays meaningful.
  if (self.role && self.role !== "farmer") {
    // merchant / banker — economic: take held crops to the shop to SELL next.
    if ((self.role === "merchant" || self.role === "banker") && crops.length > 0) {
      if (shop && !atShop && !samePos(pos, shop) && can("MOVE_TO")) {
        return moveTo(shop, "A trader's instinct — taking my goods to the shop.");
      }
    }
    // socialite — chat an ALREADY-ADJACENT neighbor (no movement → no
    // convergence), hash-gated so it stays occasional.
    if (self.role === "socialite" && can("TALK_TO") && seed % 3 === 0) {
      const neighbor = obs.nearby.agents.find((a) => cheb(pos, a.pos) <= 1);
      if (neighbor) {
        return act(
          "TALK_TO",
          `A sociable sort — ${neighbor.name} is right here, why not chat.`,
          `Lovely to run into you, ${neighbor.name}!`,
          { agentName: neighbor.name },
        );
      }
    }
    // wanderer — drift to a nearby UNOCCUPIED, passable tile (dispersive: never
    // toward the tavern, never toward another agent).
    if (self.role === "wanderer" && can("MOVE_TO")) {
      const occupied = (t: { x: number; y: number }): boolean =>
        obs.nearby.agents.some((a) => samePos(a.pos, t));
      const drifts = obs.nearby.tiles.filter(
        (t) =>
          (t.type === "grass" || t.type === "path" || t.type === "soil") &&
          !t.crop &&
          !samePos(t, pos) &&
          !occupied(t),
      );
      const dest = nearest(pos, drifts);
      if (dest) {
        return moveTo({ x: dest.x, y: dest.y }, "Restless feet — wandering on a while.");
      }
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
 * Templated first-person diary entry (mock path, modeled on mockReflection):
 * a short 1-2 sentence journal line composed from the count of the day's
 * memories plus a couple of snippets. Deterministic — same inputs, same entry;
 * NO Math.random, NO Date. Empty memory list yields a sane "quiet day" entry.
 */
export function mockDiary(
  agentName: string,
  memories: { text: string }[],
): { text: string } {
  const texts = (Array.isArray(memories) ? memories : [])
    .map((m) => (typeof m?.text === "string" ? m.text.replace(/[.\s]+$/, "").trim() : ""))
    .filter((t) => t.length > 0);
  if (texts.length === 0) {
    return { text: `Dear journal: the day felt quiet, and nothing much stood out to me.` };
  }
  // Deterministically pick a couple of snippets (seeded by name + first text).
  const seed = hash(`${agentName}:${texts[0]}`);
  const first = texts[seed % texts.length];
  const second = texts.length > 1 ? texts[(seed + 1) % texts.length] : null;
  const tail =
    second && second !== first ? ` I also remember that ${second.toLowerCase()}.` : "";
  return {
    text: `Dear journal: today I had ${texts.length} moment${texts.length === 1 ? "" : "s"} worth noting — chiefly, ${first.toLowerCase()}.${tail}`,
  };
}

/**
 * Sensible deterministic 4-step plan (rule 12 mock path): one step per
 * phase, night always ends at the bed. Plans now mix farm work with social
 * and leisure activities keyed to persona keywords. A deterministic per-
 * (persona+day) hash picks among several non-farm afternoon/evening options
 * so different agents on different days get visibly varied routines.
 *
 * Persona keys:
 *  "social"  → more socializing (tavern hang, chatting)
 *  "dreamy"/"moonstruck"/"moss"/"moon" → pond visits, reflection
 *  "frugal"/"fern"  → market browsing, price-haggling
 *  "reckless"/"rusty" → impulsive morning, wanders
 *  "wandering"/"wren" → strolling, exploring landmarks
 *  others → farm-dominant with light leisure rotation
 */
export function mockDailyPlan(
  persona: string,
  day: number,
  goal?: string,
  role?: string,
): { steps: PlanStep[]; rawText: string } {
  const p = (persona ?? "").toLowerCase();
  const social = p.includes("social");
  const dreamy =
    p.includes("dreamy") || p.includes("moonstruck") || p.includes("moss") || p.includes("moon");
  const frugal = p.includes("frugal") || p.includes("fern");
  const reckless = p.includes("reckless");
  const wanderer = p.includes("wander") || p.includes("wren") || p.includes("roam");

  // Deterministic variety seed — different per persona + day
  const varietySeed = hash(`${p}:${day}`) % 4; // 0..3

  // Morning: mostly farm; reckless is impulsive; wanderer strolls first
  let morningGoal: string;
  if (reckless) {
    morningGoal = `day ${day}: charge into the field — till and plant whatever looks promising`;
  } else if (wanderer && varietySeed === 0) {
    morningGoal = `day ${day}: take a morning stroll by the pond, then tend the crops`;
  } else {
    morningGoal = `day ${day}: water every planted crop, then till and plant free plots`;
  }

  // Afternoon: farm + occasional leisure
  let afternoonGoal: string;
  let afternoonLandmark: Landmark["kind"] | undefined;
  if (social && varietySeed < 2) {
    afternoonGoal = "socialize at the tavern and catch up with the other farmers";
    afternoonLandmark = "tavern";
  } else if (dreamy && varietySeed < 3) {
    afternoonGoal = "relax by the pond and reflect on the morning's work";
    afternoonLandmark = "water";
  } else if (frugal && varietySeed % 2 === 0) {
    afternoonGoal = "browse the market and check prices before deciding what to grow";
    afternoonLandmark = "shop";
  } else if (wanderer) {
    afternoonGoal = "wander across town, stopping to chat with any farmer in sight";
  } else {
    // Default farmers — spread the afternoon across a few divergent (and mostly
    // plot-local) activities, deterministic per persona+day, so the town shows
    // varied life instead of every default farmer doing the identical chore.
    // No convergence landmark: keywords keep them at/near their own plot or
    // strolling the paths (the party event remains the only town-wide pull).
    switch (varietySeed) {
      case 0:
        afternoonGoal = "harvest anything ready and keep the plots tended";
        break;
      case 1:
        afternoonGoal = "tend the crops and till new ground for the next planting";
        break;
      case 2:
        afternoonGoal = "take a slow walk along the field paths, checking the crops";
        break;
      default:
        afternoonGoal = "water every planted crop and tidy up around the plot edges";
        break;
    }
  }

  // Evening: social/leisure rotation or selling.
  // Only personas with explicit social or wanderer traits head to the tavern —
  // all others sell at the shop or relax by the pond. This keeps casual tavern
  // visits rare enough that the kill-switch test remains meaningful.
  let eveningGoal: string;
  let eveningLandmark: Landmark["kind"] | undefined;
  if (social) {
    eveningGoal = "gather at the tavern — share news and enjoy the company";
    eveningLandmark = "tavern";
  } else if (dreamy && varietySeed >= 2) {
    eveningGoal = "sit by the pond and watch the stars come out";
    eveningLandmark = "water";
  } else if (frugal) {
    eveningGoal = "haggle at the market, sell harvested crops at the best price";
    eveningLandmark = "shop";
  } else if (wanderer && varietySeed >= 2) {
    eveningGoal = "stroll to the tavern, share gossip, then head home";
    eveningLandmark = "tavern";
  } else {
    eveningGoal = "sell harvested crops and restock seeds at the shop";
    eveningLandmark = "shop";
  }

  // Wave 3a — goal conditioning: a synthesized standing goal re-weights the
  // afternoon/evening branches by keyword. Morning stays farm-ish and night
  // ALWAYS ends at the bed (preserves planner.test 4-step + night-at-bed). The
  // goal NEVER adds/removes steps. Fully gated: when `goal` is omitted the
  // output below is byte-identical to the v2 mock plan (mock-daily/mock-v2).
  // `goalConditioned` records whether a goal keyword claimed afternoon/evening,
  // so the Wave-5b role block only fills phases the goal left at default.
  let goalConditioned = false;
  if (goal) {
    const g = goal.toLowerCase();
    if (g.includes("tavern") || g.includes("sociali") || g.includes("chat") || g.includes("gather")) {
      afternoonGoal = "socialize at the tavern and catch up with the other farmers";
      afternoonLandmark = "tavern";
      eveningGoal = "gather at the tavern — share news and enjoy the company";
      eveningLandmark = "tavern";
      goalConditioned = true;
    } else if (g.includes("market") || g.includes("sell") || g.includes("haggle") || g.includes("price")) {
      afternoonGoal = "browse the market and check prices before deciding what to grow";
      afternoonLandmark = "shop";
      eveningGoal = "haggle at the market, sell harvested crops at the best price";
      eveningLandmark = "shop";
      goalConditioned = true;
    } else if (g.includes("wander") || g.includes("stroll") || g.includes("explore") || g.includes("novel")) {
      // Novelty is DISPERSIVE — wander/stroll the paths and pond, never a
      // tavern convergence (keeps the party kill-switch meaningful: only a
      // seeded event, not a restless drive, pulls the whole town together).
      afternoonGoal = "wander across town and explore the quiet paths";
      afternoonLandmark = undefined;
      eveningGoal = "take a long evening stroll by the pond before heading home";
      eveningLandmark = "water";
      goalConditioned = true;
    } else if (g.includes("pond") || g.includes("relax") || g.includes("reflect")) {
      afternoonGoal = "relax by the pond and reflect on the morning's work";
      afternoonLandmark = "water";
      eveningGoal = "sit by the pond and watch the stars come out";
      eveningLandmark = "water";
      goalConditioned = true;
    } else if (g.includes("rest") || g.includes("sleep") || g.includes("home")) {
      afternoonGoal = "rest at home and conserve energy for the work ahead";
      afternoonLandmark = "bed";
      eveningGoal = "head home early to rest before nightfall";
      eveningLandmark = "bed";
      goalConditioned = true;
    } else if (g.includes("farm") || g.includes("till") || g.includes("plant") || g.includes("water") || g.includes("crop")) {
      afternoonGoal = "tend the crops and till new ground for the next planting";
      afternoonLandmark = undefined;
      eveningGoal = "sell harvested crops and restock seeds at the shop";
      eveningLandmark = "shop";
      goalConditioned = true;
    }
  }

  // Wave 5b — ROLE CONDITIONING: a purposeful agent visits the building tied to
  // its derived role (merchant→shop, socialite→cafe, banker→office,
  // wanderer→park). STRICT no-op when `role` is undefined or "farmer", so the
  // 2-arg / farmer path stays BYTE-IDENTICAL (mock-daily / mock-v2 / planner /
  // mock-determinism all frozen). preferredLocation is PURE (no RNG/Date.now),
  // so the plan stays deterministic. The role NEVER routes to the tavern (kind
  // !== "tavern" guard) and only fills phases the goal block left at default
  // (goal keyword always wins). Morning stays farm-ish; night stays bed.
  if (role && role !== "farmer" && !goalConditioned) {
    const kind = preferredLocation(role, goal);
    // "school" is a dormant forward-compat kind (not a Landmark["kind"]) and
    // "tavern" is excluded for kill-switch safety — neither is reached by any
    // role default, only by a goal keyword no mock emits, but guard regardless.
    if (kind && kind !== "tavern" && kind !== "school") {
      const text = FUNCTIONAL_STEP_TEXT[kind];
      afternoonGoal = text.afternoon;
      afternoonLandmark = kind;
      eveningGoal = text.evening;
      eveningLandmark = kind;
    }
  }

  const steps: PlanStep[] = [
    {
      phase: "morning",
      goal: morningGoal,
      done: false,
    },
    {
      phase: "afternoon",
      goal: afternoonGoal,
      ...(afternoonLandmark ? { targetLandmark: afternoonLandmark } : {}),
      done: false,
    },
    {
      phase: "evening",
      goal: eveningGoal,
      ...(eveningLandmark ? { targetLandmark: eveningLandmark } : {}),
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

// ---------------------------------------------------------------------------
// Wave 3a — mock goal synthesis (deterministic, $0). GoalsSystem uses this
// whenever the live smart-tier goal call is unavailable. Pure argmax over the
// drive vector (matching Needs.dominant tie-break order) → a one-line goal
// whose KEYWORDS land in the mockDailyPlan re-weighting + plan-intent follower
// vocabulary, so the synthesized goal actually steers behavior. Persona/day
// variety via hash(persona:day) — NO Math.random, NO Date.now.
// ---------------------------------------------------------------------------

/** Drive keys + tie-break order — mirrors Needs.DRIVE_KEYS (kept local to
 *  avoid an agents→llm import cycle). */
const MOCK_DRIVE_KEYS = ["energy", "wealth", "social", "novelty", "purpose"] as const;

/** Pure argmax over a NeedState; ties break in MOCK_DRIVE_KEYS order. */
export function dominantDrive(needs: NeedState): (typeof MOCK_DRIVE_KEYS)[number] {
  let best: (typeof MOCK_DRIVE_KEYS)[number] = MOCK_DRIVE_KEYS[0];
  let bestVal = -Infinity;
  for (const k of MOCK_DRIVE_KEYS) {
    const v = typeof needs?.[k] === "number" && Number.isFinite(needs[k]) ? needs[k] : 0;
    if (v > bestVal) {
      best = k;
      bestVal = v;
    }
  }
  return best;
}

/** 2–3 phrasings per drive; keywords land in the plan-follower vocabulary. */
const GOAL_TEMPLATES: Record<(typeof MOCK_DRIVE_KEYS)[number], string[]> = {
  energy: [
    "rest at home and recover my strength",
    "head home to sleep off my exhaustion",
    "take it easy and rest before the next push",
  ],
  wealth: [
    "sell my harvest at the market for good coin",
    "haggle at the market to build up my savings",
  ],
  social: [
    "socialize at the tavern with the other farmers",
    "spend time chatting and catching up at the tavern",
    "gather at the tavern and enjoy some company",
  ],
  novelty: [
    "wander the town and explore something new",
    "take a long stroll and see where the paths lead",
  ],
  purpose: [
    "till, plant, and water the farm to make it thrive",
    "pour myself into the farm work and tend every crop",
    "plant new seeds and grow the farm bigger",
  ],
};

/**
 * Deterministic mock goal: dominant drive → templated one-liner, with
 * persona/day variety. Always returns a non-empty, ≤120-char single line.
 */
export function mockGoal(persona: string, needs: NeedState, day: number): string {
  const drive = dominantDrive(needs);
  const phrasings = GOAL_TEMPLATES[drive];
  const idx = hash(`${(persona ?? "").toLowerCase()}:${day}`) % phrasings.length;
  const line = phrasings[idx];
  return line.length > 120 ? line.slice(0, 120) : line;
}
