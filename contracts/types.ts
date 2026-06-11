/**
 * Harvest of Madness — shared contract types (v1)
 *
 * Single source of truth for every seam in the build. Implementation agents
 * import these shapes (copy or path-alias) and MUST NOT redeclare divergent
 * versions. Mission interfaces (docs/deep-research-v1.md §4, §6, §11) are
 * reproduced verbatim where noted.
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
// §7 World constants (authoritative values)
// ---------------------------------------------------------------------------

export const CROPS: Record<
  CropKind,
  { days: number; seedCost: number; sellPrice: number }
> = {
  parsnip: { days: 4, seedCost: 20, sellPrice: 35 },
  potato: { days: 6, seedCost: 50, sellPrice: 80 },
  cauliflower: { days: 8, seedCost: 80, sellPrice: 175 },
};

export const ENERGY_START = 100;
/** energy cost per field action (till/plant/water/harvest) */
export const ENERGY_COST_FIELD = 3;
export const STARTING_GOLD = 100;

export const MAP_WIDTH = 24;
export const MAP_HEIGHT = 18;
export const TILE_SIZE = 16;
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
  | "SLEEP"
  | "WAIT";

export interface AgentAction {
  thought: string;
  say: string | null;
  action: ActionType;
  target?: Vec2 | { itemId: string; qty: number } | { agentName: string };
  goal?: string;
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
