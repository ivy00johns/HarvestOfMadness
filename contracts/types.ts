/**
 * Harvest of Madness — shared contract types (v2.0; history in contracts/README.md)
 *
 * Single source of truth for every seam in the build. Implementation agents
 * import these shapes (copy or path-alias) and MUST NOT redeclare divergent
 * versions. Mission interfaces (docs/deep-research-v1.md §4, §6, §11) are
 * reproduced verbatim where noted; the "v2 cognition + assets" section at the
 * bottom implements docs/deep-research-v2.md (generative-agents loop + LPC
 * asset pipeline). v2 changes are ADDITIVE: new ActionTypes GIVE_GIFT/EMOTE,
 * optional fields on Observation/AgentAction/AgentCardModel, TILE_SIZE 16→32
 * (LPC art), and the new cognition seams.
 */

// ---------------------------------------------------------------------------
// Core primitives
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export type TileType =
  | "grass"
  | "path"
  | "water"
  | "tilled"
  | "soil"
  | "floor" // v3 — passable indoor floor (walkable house/tavern/shop interiors)
  | "building" // retained-but-unused: no tile stamps it anymore, but it stays a
  // valid impassable type so TILE_COLORS / placeholder / isPassable(building) need
  // no churn (see docs/.../walkable-interiors-design.md §2).
  | "bedTile"
  | "shopTile"
  | "wall";

export type CropKind = "parsnip" | "potato" | "cauliflower";

export interface CropState {
  kind: CropKind;
  /** 0..stages-1; ready when stage === CROPS[kind].days */
  stage: number;
  watered: boolean;
  ready: boolean;
}

export interface Tile {
  x: number;
  y: number;
  type: TileType;
  crop?: CropState;
}

export type Phase = "morning" | "afternoon" | "evening" | "night";

export interface TimeState {
  day: number; // starts at 1
  phase: Phase;
}

export interface InventoryEntry {
  itemId: string; // "seed:parsnip" | "crop:parsnip" | ...
  qty: number;
}

export interface Landmark {
  // "tavern" is landmark-only: a plain building footprint with no special
  // tile type (social actions need only adjacency), unlike bed→bedTile /
  // shop→shopTile. Wave 5a ADDITIVELY widens this with the new civic kinds
  // ("cafe"/"office") and the green "park" region; these are environmental
  // only — the mock router filter (src/llm/mock.ts) still drops them, so they
  // stay inert to the brain until a later wave wires them in.
  kind: "shop" | "bed" | "water" | "house" | "tavern" | "cafe" | "office" | "park";
  pos: Vec2;
}

/**
 * v3 — A placeable world object agents can perceive and interact with via
 * USE_OBJECT. Exterior only; no interior objects.
 */
export interface WorldObject {
  id: string;
  kind: "well" | "notice_board" | "bench";
  pos: Vec2;
}

// ---------------------------------------------------------------------------
// §7 World constants — v1.2: values pinned by docs/kickoff-fable5.md
// "Simulation constants (authoritative)" (anti-deadlock tuning)
// ---------------------------------------------------------------------------

export const CROPS: Record<
  CropKind,
  { days: number; seedCost: number; sellPrice: number }
> = {
  parsnip: { days: 4, seedCost: 20, sellPrice: 35 },
  potato: { days: 6, seedCost: 40, sellPrice: 80 },
  cauliflower: { days: 8, seedCost: 80, sellPrice: 175 },
};

export const ENERGY_START = 100;
/** per-action energy costs (kickoff table; MOVE_TO and non-field actions are free) */
export const ENERGY_COSTS: Record<ActionType, number> = {
  TILL: 2,
  PLANT: 1,
  WATER: 1,
  HARVEST: 2,
  MOVE_TO: 0,
  BUY: 0,
  SELL: 0,
  TALK_TO: 0,
  GIVE_GIFT: 0,
  EMOTE: 0,
  SLEEP: 0,
  WAIT: 0,
  USE_OBJECT: 0,
  VOTE: 0, // Wave 4c — town-wide governance vote; free, no adjacency (like EMOTE)
  DEPOSIT: 0, // Living Homes #2 — logistics, free (like BUY/SELL/USE_OBJECT)
  WITHDRAW: 0, // Living Homes #2 — logistics, free (like BUY/SELL/USE_OBJECT)
};
export const STARTING_GOLD = 200;
/** starting inventory: 5× "seed:parsnip" */
export const STARTING_SEEDS = 5;
/**
 * One in-game day (4 phases) must be ~20–40s in mock mode (kickoff clock rule).
 * 8s/phase = 32s/day at speed 1.
 */
export const PHASE_DURATION_MS = 8_000;

export const MAP_WIDTH = 140;
export const MAP_HEIGHT = 100;
/** v2: LPC art is 32×32; world logic is tile-indexed and never uses pixels */
export const TILE_SIZE = 32;
export const OBSERVATION_RADIUS = 4;

// ---------------------------------------------------------------------------
// Wave 3a — needs-driven goal generation (PIANO keystone)
// ---------------------------------------------------------------------------

/**
 * Intrinsic drive vector (5 needs), each in [0,1] where HIGHER = more pressing
 * (so the dominant drive is the argmax). Event-sourced inside the agent
 * cognition layer (src/agents/Needs.ts); rides Observation.self.needs +
 * AgentCardModel.needs purely as additive, optional surface data.
 */
export interface NeedState {
  energy: number;
  wealth: number;
  social: number;
  novelty: number;
  purpose: number;
}

// ---------------------------------------------------------------------------
// Wave 4a — emergent role specialization
// ---------------------------------------------------------------------------

/**
 * Town-legible role vocabulary. Roles are DERIVED inside the cognition layer
 * (src/agents/Roles.ts) from each agent's recent successful-action histogram
 * (+ a banker gold overlay), never seeded. "farmer" is the default / fallback /
 * seed role, so a fresh or below-sample agent reads as a "farmer".
 */
export const ROLE_VOCABULARY = [
  "farmer",
  "merchant",
  "socialite",
  "wanderer",
  "banker",
] as const;

/** A derived, town-legible specialization. Default/fallback is "farmer". */
export type DerivedRole = (typeof ROLE_VOCABULARY)[number];

// ---------------------------------------------------------------------------
// §4.1 Observation (mission verbatim)
// ---------------------------------------------------------------------------

export interface Observation {
  self: {
    name: string;
    persona: string;
    /**
     * Town-legible specialization. Wave 4a makes this DERIVED at runtime from
     * the agent's recent-action histogram (src/agents/Roles.ts; one of
     * ROLE_VOCABULARY). Type stays `string` (no narrowing → no breaking
     * callers); "farmer" is the default. Advisory only — surfaced to the
     * decision prompt to color choices, never to override them.
     */
    role: string;
    pos: Vec2;
    energy: number;
    gold: number;
    inventory: InventoryEntry[];
    /**
     * Living Homes #2 — per-agent home storage snapshot, surfaced so the live
     * LLM/mock can see what is stashed at home (DEPOSIT/WITHDRAW target it).
     * Additive + optional; mirrors `inventory` (copy, never the live array).
     */
    homeStorage?: InventoryEntry[];
    /**
     * Standing goal (type unchanged: string | null). Wave 3a makes it dynamic:
     * synthesized from intrinsic drives (src/agents/Goals.ts) and fed to the
     * planner as a prompt INPUT. The transient LLM action.goal still wins for
     * its own turn.
     */
    goal: string | null;
    /** Wave 3a — intrinsic drive vector, surfaced when the needs system is active. */
    needs?: NeedState;
    /** v2 — current DailyPlan step text, when the planner is active */
    currentPlanStep?: string | null;
    /** v2 — affinity snapshot for nearby/known agents, newest-first, cap 5 */
    relationships?: { name: string; affinity: number }[];
    /**
     * v3 — events this agent has heard about (for attend/spread behavior).
     * Phase C · Slice 1: `homePathTiles` is the agent's home→event A* path length
     * (tiles), computed in Cognition.enrichObservation and read by the mock
     * attendance gate. Optional + additive — absent on every synthetic
     * Observation, so existing callers / wire / redact tests are unaffected.
     */
    knownEvents?: (SimEvent & { isNow: boolean; homePathTiles?: number })[];
    /** v3 — for an event host: town agents who have NOT yet heard about it (with positions), so the host can go invite them. */
    inviteTargets?: { name: string; pos: Vec2 }[];
    /**
     * Wave 4c — the one active town proposal this agent is AWARE of, surfaced so
     * the decision prompt can show it and the agent can cast a VOTE. Additive +
     * client-only (no server/wire change); absent when there is no open proposal
     * the agent knows about. `yes`/`no` are the live tally; `awareCount` is how
     * many agents have heard of it.
     */
    activeProposal?: {
      id: string;
      proposer: string;
      ruleText: string;
      day: number;
      awareCount: number;
      yes: number;
      no: number;
    };
    /**
     * Wave 4c — this agent's recorded stance on `activeProposal` (true = yes,
     * false = no), or absent when the agent has not voted yet. Drives the
     * VOTE-injection gate in Cognition.enrichObservation (no re-vote once set).
     */
    myVote?: boolean;
  };
  time: TimeState;
  nearby: {
    tiles: {
      x: number;
      y: number;
      type: TileType;
      crop?: { kind: string; stage: number; watered: boolean; ready: boolean };
    }[]; // radius ~4
    agents: { name: string; pos: Vec2; lastSeenDoing: string }[];
    landmarks: Landmark[];
    /** v3 — world objects within OBSERVATION_RADIUS (well, notice_board, bench) */
    objects?: WorldObject[];
  };
  lastAction: { action: string; ok: boolean; reason?: string } | null;
  availableActions: ActionType[];
  economy: { sells: Record<string, number>; buys: Record<string, number> };
  /** v2 — top-k retrieved memories injected into the decision prompt */
  memories?: { text: string; type: MemoryType; importance: number }[];
}

// ---------------------------------------------------------------------------
// §4.3 AgentAction (mission verbatim)
// ---------------------------------------------------------------------------

export type ActionType =
  | "MOVE_TO"
  | "TILL"
  | "PLANT"
  | "WATER"
  | "HARVEST"
  | "BUY"
  | "SELL"
  | "TALK_TO"
  | "GIVE_GIFT" // v2 — target {agentName, itemId, qty:1}; adjacency + ownership required
  | "EMOTE" // v2 — always legal; renders a transient emote above the sprite
  | "SLEEP"
  | "WAIT"
  | "USE_OBJECT" // v3 — target {objectId: string}; adjacency to the object required
  | "VOTE" // Wave 4c — target {proposalId: string; support: boolean}; town-wide governance vote, no adjacency
  | "DEPOSIT" // Living Homes #2 — target {itemId, qty}; must stand on your bed tile; moves goods from inventory into home storage
  | "WITHDRAW"; // Living Homes #2 — target {itemId, qty}; must stand on your bed tile; moves goods from home storage back into inventory

/** v2 — surfaced on speech bubbles and emotes */
export type Emotion = "neutral" | "happy" | "annoyed" | "sad" | "excited";

export interface AgentAction {
  thought: string;
  say: string | null;
  action: ActionType;
  target?:
    | Vec2
    | { itemId: string; qty: number }
    | { agentName: string }
    | { agentName: string; itemId: string; qty: number } // GIVE_GIFT
    | { objectId: string } // USE_OBJECT — v3
    | { proposalId: string; support: boolean }; // VOTE — Wave 4c
  goal?: string;
  /** v2 — optional; defaults to "neutral" */
  emotion?: Emotion;
}

/** Result of validating/applying an action. Reject loudly, never crash. */
export interface ActionResult {
  ok: boolean;
  reason?: string; // human-readable, fed back via Observation.lastAction
}

// ---------------------------------------------------------------------------
// §11 Router seam (mission verbatim)
// ---------------------------------------------------------------------------

export interface LlmRequest {
  agentId: string;
  system: string;
  user: string;
  jsonSchema?: object;
  /** v2 — tiered routing; forwarded as CompleteRequest.tier (mock ignores) */
  tier?: "fast" | "smart";
  /**
   * v3 — completion token cap. Absent = server default. The decision retry
   * boosts this (max(base*4, 2048)) when attempt 1 died of length/truncation,
   * so a reasoning-model reroute can't starve the JSON. Mock ignores.
   */
  maxTokens?: number;
}

export interface LlmResponse {
  raw: string;
  parsed?: AgentAction;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
  /**
   * v3 — when the pinned model failed and the call was retried once on the
   * proxy's `auto` router, these record the swap (home → auto's real model)
   * so the inspector shows which model actually answered.
   */
  bouncedFrom?: string;
  bouncedTo?: string;
  /** v3 — upstream finish_reason (e.g. "length"); drives truncation handling */
  finishReason?: string;
}

export type Router = (req: LlmRequest) => Promise<LlmResponse>;

// ---------------------------------------------------------------------------
// §6 Async scheduler (no global tick)
// ---------------------------------------------------------------------------

export type AgentFsmState = "IDLE" | "THINKING" | "EXECUTING";

export interface SchedulerConfig {
  /** global cap on concurrent in-flight LLM decisions */
  maxConcurrentDecisions: number; // default 3
  /** per-agent ms between decision requests */
  decisionCooldownMs: number; // mock ~2500, live ~6000
  /**
   * Opt-in daily live-decision ceiling. `<= 0` means UNLIMITED (the default):
   * FreeLLMAPI tokens are free, so we do not self-throttle. Set a positive
   * value only to deliberately cap a session (e.g. a demo); past it agents
   * fall back to the mock heuristic and a budget_reached event fires.
   */
  maxDecisionsPerDay: number; // 0 = unlimited (default)
}

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  maxConcurrentDecisions: 3,
  decisionCooldownMs: 2500,
  maxDecisionsPerDay: 0, // unlimited — opt in to a cap via a positive value
};

// ---------------------------------------------------------------------------
// World engine public API (consumed by agents/* — implemented by world/*)
// ---------------------------------------------------------------------------

export interface WorldApi {
  readonly width: number;
  readonly height: number;
  getTile(x: number, y: number): Tile | null;
  /** all tiles within Chebyshev radius r of pos (clipped to map) */
  tilesInRadius(pos: Vec2, r: number): Tile[];
  isPassable(x: number, y: number): boolean;
  /** 4-neighbour adjacency or same tile */
  isAdjacent(a: Vec2, b: Vec2): boolean;
  /** A* over passable tiles; null when unreachable */
  findPath(from: Vec2, to: Vec2): Vec2[] | null;
  landmarks(): Landmark[];
  /** v3 — all world objects (well, notice_board, bench); defensive copy. */
  objects(): WorldObject[];
  /** v3 — find the closest world object adjacent to pos, if any. */
  adjacentObject(pos: Vec2): WorldObject | null;

  time(): TimeState;
  /**
   * SLEEP semantics (world-owned): advance to next morning, +1 stage for
   * every watered crop, reset watered=false on all crops, recompute ready.
   */
  advanceDay(): void;

  // Farm mutations — precondition-checked, never throw (§4.4)
  till(p: Vec2): ActionResult;
  plant(p: Vec2, kind: CropKind): ActionResult;
  water(p: Vec2): ActionResult;
  /** on ok, also returns the harvested itemId for inventory credit */
  harvest(p: Vec2): ActionResult & { itemId?: string };

  // Economy (§7) — pure price lookups; gold/inventory mutation is executor's job
  sellPrices(): Record<string, number>; // "crop:parsnip" -> 35
  buyPrices(): Record<string, number>; // "seed:parsnip" -> 20
}

// ---------------------------------------------------------------------------
// Render seam (v1.1 addendum) — implemented by WorldScene (world-agent),
// consumed by the agent pipeline (agents-agent) for sprite + speech rendering.
// Agents are data; the world scene owns all drawing.
// ---------------------------------------------------------------------------

export interface RenderApi {
  /**
   * v2: binds the agent to an LPC character sheet from AssetManifest by
   * round-robin/name; labeled-circle placeholder remains the no-assets
   * fallback (the game must still boot with public/assets/ empty).
   */
  registerAgentSprite(name: string, color: number, pos: Vec2): void;
  /**
   * tween/walk the sprite toward tile pos; instant when speed multiplier
   * high. v2: plays the directional LPC walk animation inferred from the
   * movement vector; idles (animation stop) on arrival.
   */
  setAgentPos(name: string, pos: Vec2): void;
  /** transient speech bubble above the sprite (~4s, truncate ~60 chars) */
  showSpeech(name: string, text: string, emotion?: Emotion): void;
  /** v2 — transient emote icon/tint above the sprite (~2s) */
  playEmote(name: string, emotion: Emotion): void;
}

// ---------------------------------------------------------------------------
// §8 Observability — event log + inspector data model (PDoM pattern: every
// decision groups its spans under one turnId)
// ---------------------------------------------------------------------------

export type EventKind =
  | "turn_start" // decision requested
  | "llm_call" // request resolved (model/latency/tokens/cached)
  | "action_chosen" // parsed AgentAction accepted
  | "action_resolved" // executor outcome ok|rejected
  | "parse_failure"
  | "agent_speech"
  | "agent_moved"
  | "economy" // buy/sell
  | "day_advanced"
  | "budget_reached"
  | string; // open kind space — consumers MUST tolerate unknown kinds

export interface WorldEvent {
  seq: number; // monotonic
  day: number;
  phase: Phase;
  kind: EventKind;
  agentName?: string;
  turnId?: string; // correlates one decision's chain
  text: string; // human-readable feed line
  payload?: Record<string, unknown>; // kind-specific
  ts: number; // Date.now()
}

export interface EventBus {
  emit(e: Omit<WorldEvent, "seq" | "ts">): void;
  on(cb: (e: WorldEvent) => void): () => void; // returns unsubscribe
  /** newest-last ring buffer snapshot (cap 1000) */
  recent(limit?: number): WorldEvent[];
}

/** Per-agent inspector card (§8) — rendered by UIScene, fed by obs/Inspector */
export interface AgentCardModel {
  name: string;
  persona: string;
  gold: number;
  energy: number;
  /** Standing goal (Wave 3a: synthesized from drives; type unchanged). */
  goal: string | null;
  /** Wave 3a — intrinsic drive vector for the card's needs row, when present. */
  needs?: NeedState;
  /** Wave 4a — derived role tag for the card (one of ROLE_VOCABULARY), when non-default. */
  role?: string;
  lastThought: string | null;
  lastSay: string | null;
  lastAction: { action: string; ok: boolean; reason?: string } | null;
  model: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  decisionsToday: number;
  decisionsTotal: number;
  fsm: AgentFsmState;
  /** expandable decision trace: newest-first, cap ~20 per agent */
  trace: DecisionTraceEntry[];
  /** v2 — current plan step text shown on the card */
  planStep?: string | null;
  /** v2 — affinity rows for the card's relationship meter */
  relationships?: { name: string; affinity: number; summary: string }[];
  /** v2 — memory stream stats for the card */
  memoryCount?: number;
  reflectionCount?: number;
}

export interface DecisionTraceEntry {
  turnId: string;
  day: number;
  phase: Phase;
  observationJson: string; // raw JSON.stringify(observation) sent
  rawResponse: string; // raw model text
  parsedOk: boolean;
  action: string | null;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

// ---------------------------------------------------------------------------
// Server proxy wire contract (client liveRouter <-> server/) — see openapi.yaml
// ---------------------------------------------------------------------------

/** POST /api/agent/complete request body */
export interface CompleteRequest {
  agentId: string;
  system: string;
  user: string;
  jsonSchema?: object;
  /**
   * v2 — tiered routing (deep-research-v2 §4). "fast" = routine decisions +
   * importance scoring; "smart" = dialogue/reflection/planning. Server maps
   * tiers to FREELLMAPI_MODEL_FAST / FREELLMAPI_MODEL_SMART (default "auto").
   */
  tier?: "fast" | "smart";
  /** v3 — completion token cap; absent = server default (see LlmRequest.maxTokens) */
  maxTokens?: number;
}

/** POST /api/agent/complete 200 body (mirrors LlmResponse minus `parsed`) */
export interface CompleteResponse {
  raw: string;
  model: string; // X-Routed-Via from FreeLLMAPI, else echoed model field
  latencyMs: number; // measured server-side
  tokensIn?: number;
  tokensOut?: number;
  /** v3 — set when the request bounced to the `auto` router (home → auto model) */
  bouncedFrom?: string;
  bouncedTo?: string;
  /** v3 — upstream finish_reason when present (drives client truncation handling) */
  finishReason?: string;
}

/** Any non-200 from the proxy */
export interface ApiError {
  error: {
    message: string;
    type:
      | "authentication_error"
      | "rate_limit_error"
      | "budget_exceeded"
      | "upstream_error"
      | "invalid_request_error"
      | "server_error";
  };
}

/** v2 — POST /api/embeddings request body (proxy → FreeLLMAPI /v1/embeddings) */
export interface EmbedRequest {
  texts: string[]; // 1..32 per call; batch aggressively
}

/** v2 — POST /api/embeddings 200 body */
export interface EmbedResponse {
  embeddings: number[][]; // same order as texts
  model: string;
}

// ===========================================================================
// v2 — Generative-agents cognition (docs/deep-research-v2.md §3)
// Memory stream → retrieval → reflection → daily planning. All stores are
// client-side in-memory (4–6 NPCs); embeddings come via POST /api/embeddings.
// Everything here degrades gracefully: with the server down or in mock mode,
// embedding-relevance is 0 and importance uses the heuristic table — the
// game must keep running ($0 mock-first rule stands).
// ===========================================================================

export type MemoryType = "observation" | "reflection" | "plan";

/** game-time stamp; 1 phase = 6 game hours (day = 24h, 4 phases) */
export interface GameStamp {
  day: number;
  phase: Phase;
}

export const PHASE_HOURS: Record<Phase, number> = {
  morning: 0,
  afternoon: 6,
  evening: 12,
  night: 18,
};

/** absolute game-hours since day 1 morning — recency decay input */
export function gameHours(t: GameStamp): number {
  return (t.day - 1) * 24 + PHASE_HOURS[t.phase];
}

export interface MemoryEntry {
  id: string; // `${agentName}-m${counter}`
  agentName: string;
  type: MemoryType;
  text: string;
  /** 1–10 poignancy; live: fast-tier LLM rating at write time; mock: heuristic */
  importance: number;
  createdAt: GameStamp;
  /** bumped on every retrieval hit (Park recency semantics) */
  lastAccess: GameStamp;
  /** absent when the embeddings endpoint is unavailable (mock / offline) */
  embedding?: number[];
  /** reflections cite the memory ids they were inferred from */
  sourceIds?: string[];
  /**
   * Wave 4b — stable story-origin id for a relayed-gossip memory: the id of
   * the first-hand source observation (e.g. "Alice-m3"), minted once and
   * propagated UNCHANGED through every relay hop. Absent on non-gossip memories.
   * Drives origin-dedup (a listener already knowing an origin is never re-told).
   */
  origin?: string;
  /**
   * Wave 4b — relay distance for a gossip memory: hop 1 = heard directly from
   * the first-hand sharer; hop n+1 = relayed from a hop-n holder. Capped at
   * GOSSIP_MAX_HOPS. Absent on non-gossip memories.
   */
  hop?: number;
  /**
   * Wave 4c (C2) — the rumor's SUBJECT: the first-hand author the rumor traces
   * to, captured at hop 1 and propagated UNCHANGED through every relay hop
   * (gossip-only, like origin). The telephone game keeps WHO the story is about.
   * Absent on non-gossip memories.
   */
  subject?: string;
  /**
   * Wave 4c (C2) — the CANONICAL (undistorted) claim gist, captured at hop 1 and
   * propagated UNCHANGED. The rendered `text` applies intensifyClaim(claim, hop);
   * relays read THIS canonical claim, never the distorted text, so distortion
   * never compounds (bounded ≤ 2 steps by GOSSIP_MAX_HOPS). Absent on non-gossip.
   */
  claim?: string;
}

export interface RetrievalConfig {
  /** Park et al. decay factor per game-hour since lastAccess */
  decay: number; // 0.995
  topK: number; // 5
  /** normalized-term weights; equal by default */
  weights: { recency: number; importance: number; relevance: number };
}

export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  decay: 0.995,
  topK: 5,
  weights: { recency: 1, importance: 1, relevance: 1 },
};

/**
 * score = w_rec·decay^hoursSince(lastAccess) + w_imp·(importance/10)
 *       + w_rel·cosine(queryEmb, memEmb)   (rel term 0 when either emb missing)
 */
export interface MemoryStore {
  /** assigns id + lastAccess, requests embedding (best-effort, async-safe) */
  append(
    e: Omit<MemoryEntry, "id" | "lastAccess" | "embedding">
  ): Promise<MemoryEntry>;
  /** top-k by score; bumps lastAccess on returned entries */
  retrieve(agentName: string, query: string, k?: number): Promise<MemoryEntry[]>;
  all(agentName: string): MemoryEntry[];
  /** importance sum of observations since the last reflection (trigger input) */
  importanceSinceReflection(agentName: string): number;
}

/** reflection fires when summed importance crosses this (≈2–3×/game-day) */
export const REFLECTION_IMPORTANCE_THRESHOLD = 30;

export interface ReflectionEngine {
  /**
   * No-op below threshold. Above it (smart tier): salient questions →
   * retrieve → insights with sourceIds; stores and returns the new
   * reflection memories. Mock mode: templated summary reflection.
   */
  maybeReflect(agentName: string): Promise<MemoryEntry[]>;
}

export interface PlanStep {
  phase: Phase;
  goal: string; // "water the crops on the east plot"
  targetLandmark?: Landmark["kind"];
  done: boolean;
}

export interface DailyPlan {
  agentName: string;
  day: number;
  steps: PlanStep[]; // exactly 4, one per phase
  rawText: string; // verbatim model output for the inspector
}

export interface Planner {
  /** each morning (smart tier); stored as a `plan` memory. Mock: persona-templated */
  planDay(agentName: string, day: number): Promise<DailyPlan>;
  current(agentName: string): DailyPlan | null;
  /** mark progress; the current step feeds Observation.self.currentPlanStep */
  advance(agentName: string, phase: Phase): void;
}

/**
 * A single end-of-day first-person journal entry (additive subsystem modeled on
 * reflection). One per agent per game-day: `day`/`phase` stamp the day that just
 * ended, `text` is a short (1-2 sentence) first-person summary generated from the
 * agent's memory stream. Live: one LLM call; Mock: deterministic template.
 */
export interface DiaryEntry {
  day: number;
  phase: string;
  text: string;
}

// ---------------------------------------------------------------------------
// v2 — Social relationship memory (AGA pattern, deep-research-v2 §3b)
// ---------------------------------------------------------------------------

export interface RelationshipSummary {
  agentName: string; // owner of this view (relationships are asymmetric)
  otherName: string;
  affinity: number; // -100..100, starts 0
  summary: string; // one-liner in the owner's voice ("she helped fix my fence")
  interactions: number;
  updatedDay: number;
}

export const AFFINITY_DELTAS = {
  TALK_TO: 2,
  GIVE_GIFT: 10,
} as const;

export interface RelationshipStore {
  get(agentName: string, otherName: string): RelationshipSummary | null;
  allFor(agentName: string): RelationshipSummary[];
  /**
   * applies the affinity delta immediately (table above); summary text is
   * refreshed lazily via the smart tier at most once per day per pair.
   */
  recordInteraction(
    agentName: string,
    otherName: string,
    kind: "TALK_TO" | "GIVE_GIFT",
    eventText: string
  ): void;
  /**
   * Phase C · Slice C1 — apply a conversation-WARMTH bonus (a positive-only raw
   * affinity delta) to an existing/new pair. Adjusts affinity only (clamped);
   * does NOT bump talks/interactions/gift counters (the talk was already counted
   * by the synchronous recordInteraction). Guards bonus<=0 so it can never lower
   * affinity (warmth-only). Emits the same "relationship_updated" event shape
   * { otherName, affinity, delta: bonus } so the feed + inspector update.
   */
  recordWarmth(
    agentName: string,
    otherName: string,
    bonus: number,
    eventText: string
  ): void;
}

// ---------------------------------------------------------------------------
// v2 — Asset manifest (produced by asset-agent at public/assets/manifest.json;
// consumed by BootScene/WorldScene. The render layer must boot with the
// manifest MISSING — placeholder graphics remain the fallback.)
// ---------------------------------------------------------------------------

export interface CharacterAsset {
  name: string;
  key: string; // Phaser texture key
  path: string; // relative to public/
  frameWidth: number; // 64
  frameHeight: number; // 64
  rows: { walkUp: number; walkLeft: number; walkDown: number; walkRight: number };
  framesPerRow: number; // LPC walk = 9 (frame 0 idle + 8 cycle)
}

export interface CropAsset {
  kind: string; // matches CropKind
  path: string;
  frameWidth: number;
  frameHeight: number;
  /** frame index per growth stage, seed→ready (5 entries) */
  stageFrames: number[];
}

export interface TilesetAsset {
  key: string;
  path: string;
  tileWidth: number;
  tileHeight: number;
  purpose: "terrain" | "water" | "farming" | "buildings" | "trees";
  notes: string;
}

export interface AssetManifest {
  version: 1;
  tileSize: number; // 32
  characters: CharacterAsset[];
  crops: CropAsset[];
  tilesets: TilesetAsset[];
  water: { key: string; path: string; animFrames: number; notes: string };
}

// v2 EventKind additions (open union — documented, not enforced):
//   "memory_written"        payload { memoryId, type, importance }
//   "reflection"            payload { questions?: string[], insightIds: string[] }
//   "diary"                 payload { day, phase, text }   → end-of-day first-person journal entry
//   "plan_created"          payload { day, steps: string[] }
//   "relationship_updated"  payload { otherName, affinity, delta }
//   "gift_given"            payload { from, to, itemId }
//   "agent_emote"           payload { emotion }
//   "llm_offline"           payload { reason }   → HUD shows kill-switch badge
//   "llm_recovered"
// v3 EventKind additions (open union — documented, not enforced):
//   "event_seeded"          payload { eventId, host, description }
//   "event_heard"           payload { eventId, from, to }
//   "event_arrived"         payload { eventId, agentName }

// ---------------------------------------------------------------------------
// v3 (Wave 2) — Readable multi-turn conversations
// ---------------------------------------------------------------------------

/** One spoken line in a back-and-forth conversation. */
export interface ConversationTurn {
  speaker: string;
  text: string;
}

/**
 * A complete multi-turn exchange between two agents (≤ MAX_TURNS utterances,
 * strict alternation starting with the opener's speaker). The full transcript
 * lives in the "conversation" WorldEvent payload — NOT in the memory stream
 * (only one legacy reply pair is written per conversation; see Conversation.ts).
 */
export interface Conversation {
  id: string;
  participants: [string, string];
  turns: ConversationTurn[];
  day: number;
  phase: Phase;
}

// "conversation" WorldEvent payload (open union — documented, not enforced):
//   payload {
//     speaker: string,            // A (opener)
//     listener: string,           // B
//     say: string,                // A's opener (turns[0].text)
//     reply: string,              // B's first reply (turns[1].text), legacy field
//     turns: ConversationTurn[],  // full alternating transcript (length 2..MAX_TURNS)
//     conversationId: string,     // "${A}|${B}|${day}|${phase}"
//   }
// text stays "A: \"…\"  —  B: \"…\"" (backward compatible feed line).

// ---------------------------------------------------------------------------
// v3 — Seeded social events (smallville party-emergence design)
// ---------------------------------------------------------------------------

/** A planned social gathering that can diffuse through the agent network. */
export interface SimEvent {
  id: string;
  /** Agent name of the host who seeded the event. */
  host: string;
  /** Where the gathering happens (e.g. the tavern door tile). */
  location: Vec2;
  day: number;
  phase: Phase;
  /** Human-readable description, e.g. "a gathering at the tavern". */
  description: string;
}

// ---------------------------------------------------------------------------
// Wave 4c — Governance v1 (propose + vote on a town rule). CLIENT-ONLY (no
// server/wire change): the model lives entirely in src/agents/Governance.ts,
// diffuses like an event, and surfaces additively on Observation.self. PROPOSE
// rides USE_OBJECT on the notice_board; VOTE is the only new ActionType.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a town proposal. `open` is the only non-terminal state;
 * `adopted`/`rejected` are absorbing (resolveIfDue guarantees termination via
 * the dual rule: early majority OR deadline-with-quorum). Open union — consumers
 * MUST tolerate unknown statuses.
 */
export type ProposalStatus = "open" | "adopted" | "rejected" | string;

/**
 * A proposed town rule (farming/economy conduct, NEVER a gathering — preserves
 * the party kill-switch). Exactly one may be `open` at a time. The deadline is
 * the evening of `day + 1` (closeDay/closePhase). In-memory only; never persisted.
 */
export interface TownProposal {
  id: string;
  /** Agent name who opened the proposal (auto-aware + auto-yes). */
  proposer: string;
  /** The conduct rule, e.g. "always water a neighbour's thirsty crop". */
  ruleText: string;
  /** Game-day the proposal opened. */
  day: number;
  /** Phase the proposal opened. */
  phase: Phase;
  /** Deadline day (openDay + 1) — at this day's evening the tally resolves. */
  closeDay: number;
  /** Deadline phase ("evening"). */
  closePhase: Phase;
  status: ProposalStatus;
}

/**
 * Read-only tally snapshot for the observability HUD + the VOTE-injection gate.
 * Pure data; arrays are fresh copies.
 */
export interface ProposalTally {
  id: string;
  proposer: string;
  ruleText: string;
  status: ProposalStatus;
  yes: number;
  no: number;
  /** Agents who have heard of the proposal (proposer included). */
  awareCount: number;
  /** Agents who have cast a vote (yes or no). */
  votedCount: number;
  /** Names of agents who voted, newest-last. */
  voterNames: string[];
}

// Wave 4c EventKind additions (open union — documented, not enforced):
//   "proposal_opened"    payload { proposalId, proposer, ruleText }
//   "proposal_heard"     payload { proposalId, from, to }
//   "proposal_resolved"  payload { proposalId, adopted, yes, no, awareCount }
