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
  | "building"
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
  kind: "shop" | "bed" | "water" | "house";
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
};
export const STARTING_GOLD = 200;
/** starting inventory: 5× "seed:parsnip" */
export const STARTING_SEEDS = 5;
/**
 * One in-game day (4 phases) must be ~20–40s in mock mode (kickoff clock rule).
 * 8s/phase = 32s/day at speed 1.
 */
export const PHASE_DURATION_MS = 8_000;

export const MAP_WIDTH = 24;
export const MAP_HEIGHT = 18;
/** v2: LPC art is 32×32; world logic is tile-indexed and never uses pixels */
export const TILE_SIZE = 32;
export const OBSERVATION_RADIUS = 4;

// ---------------------------------------------------------------------------
// §4.1 Observation (mission verbatim)
// ---------------------------------------------------------------------------

export interface Observation {
  self: {
    name: string;
    persona: string;
    role: string;
    pos: Vec2;
    energy: number;
    gold: number;
    inventory: InventoryEntry[];
    goal: string | null;
    /** v2 — current DailyPlan step text, when the planner is active */
    currentPlanStep?: string | null;
    /** v2 — affinity snapshot for nearby/known agents, newest-first, cap 5 */
    relationships?: { name: string; affinity: number }[];
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
  | "WAIT";

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
    | { agentName: string; itemId: string; qty: number }; // GIVE_GIFT
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
}

export interface LlmResponse {
  raw: string;
  parsed?: AgentAction;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
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
  /** hard daily ceiling; past it agents fall back to mock heuristic */
  maxDecisionsPerDay: number; // default 200
}

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  maxConcurrentDecisions: 3,
  decisionCooldownMs: 2500,
  maxDecisionsPerDay: 200,
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
  goal: string | null;
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
}

/** POST /api/agent/complete 200 body (mirrors LlmResponse minus `parsed`) */
export interface CompleteResponse {
  raw: string;
  model: string; // X-Routed-Via from FreeLLMAPI, else echoed model field
  latencyMs: number; // measured server-side
  tokensIn?: number;
  tokensOut?: number;
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
//   "plan_created"          payload { day, steps: string[] }
//   "relationship_updated"  payload { otherName, affinity, delta }
//   "gift_given"            payload { from, to, itemId }
//   "agent_emote"           payload { emotion }
//   "llm_offline"           payload { reason }   → HUD shows kill-switch badge
//   "llm_recovered"
