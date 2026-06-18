/**
 * Agent — pure data + inventory helpers. No Phaser, no LLM imports; the
 * runtime/executor/manager mutate these fields and the obs layer reads them
 * to build AgentCardModel (contracts §8).
 */
import type {
  AgentFsmState,
  DecisionTraceEntry,
  InventoryEntry,
  NeedState,
  Vec2,
} from "@contracts/types";
import { ENERGY_START, STARTING_GOLD, STARTING_SEEDS } from "@contracts/types";

/** Persona definition (mission §9) — consumed by AgentManager.start(). */
export interface Persona {
  id: string;
  name: string;
  /** fed to buildSystemPrompt + Observation.self.persona */
  description: string;
  /** sprite color (RenderApi.registerAgentSprite) */
  color: number;
  /** starting tile (farmhouse area) */
  start: Vec2;
}

/** Newest-first decision-trace cap (contracts §8 AgentCardModel). */
export const TRACE_CAP = 20;

export class Agent {
  readonly name: string;
  readonly persona: { id: string; description: string };
  readonly role = "farmer";
  readonly color: number;

  pos: Vec2;
  energy: number = ENERGY_START;
  gold: number = STARTING_GOLD;
  inventory: InventoryEntry[] = [{ itemId: "seed:parsnip", qty: STARTING_SEEDS }];
  goal: string | null = null;
  lastAction: { action: string; ok: boolean; reason?: string } | null = null;
  lastThought: string | null = null;
  lastSay: string | null = null;
  fsm: AgentFsmState = "IDLE";
  decisionsToday = 0;
  decisionsTotal = 0;
  /**
   * Permanent per-agent mock fallback after a server `budget_exceeded`
   * error (domain rule 5). The manager-level daily ceiling is separate.
   */
  budgetFallback = false;
  /** Observation.nearby.agents[].lastSeenDoing for OTHER agents. */
  lastSeenDoing = "just arrived";
  /** TALK_TO relationship counter: other agent name -> count. */
  relationships: Record<string, number> = {};
  // -- v2 cognition card fields (AgentCardModel optional v2 contract) --------
  // Maintained by CognitionSystem; the obs layer reads them off the agent.
  /** current DailyPlan step text (AgentCardModel.planStep) */
  planStep: string | null = null;
  /** Wave 3a — intrinsic drive vector (AgentCardModel.needs); card-projection store. */
  needs: NeedState | null = null;
  /** top-5 affinity rows incl. summaries (AgentCardModel.relationships) */
  relationshipRows: { name: string; affinity: number; summary: string }[] = [];
  /** memory stream size (AgentCardModel.memoryCount) */
  memoryCount = 0;
  /** reflections stored so far (AgentCardModel.reflectionCount) */
  reflectionCount = 0;
  /** Newest-first decision trace, cap TRACE_CAP. */
  trace: DecisionTraceEntry[] = [];
  /** Monotonic per-agent counter for turnId = `${name}-${counter}`. */
  turnCounter = 0;

  constructor(p: Persona) {
    this.name = p.name;
    this.persona = { id: p.id, description: p.description };
    this.color = p.color;
    this.pos = { ...p.start };
  }

  countItem(itemId: string): number {
    const entry = this.inventory.find((i) => i.itemId === itemId);
    return entry ? entry.qty : 0;
  }

  addItem(itemId: string, qty: number): void {
    if (qty <= 0) return;
    const entry = this.inventory.find((i) => i.itemId === itemId);
    if (entry) entry.qty += qty;
    else this.inventory.push({ itemId, qty });
  }

  /** Remove qty of itemId; returns false (and removes nothing) when short. */
  removeItem(itemId: string, qty: number): boolean {
    if (qty <= 0) return false;
    const entry = this.inventory.find((i) => i.itemId === itemId);
    if (!entry || entry.qty < qty) return false;
    entry.qty -= qty;
    if (entry.qty === 0) {
      this.inventory = this.inventory.filter((i) => i !== entry);
    }
    return true;
  }

  /** First held seed entry ("seed:<kind>", qty>0) or null. */
  firstSeed(): InventoryEntry | null {
    return (
      this.inventory.find((i) => i.itemId.startsWith("seed:") && i.qty > 0) ??
      null
    );
  }

  /** Newest-first push, capped at TRACE_CAP. */
  pushTrace(entry: DecisionTraceEntry): void {
    this.trace.unshift(entry);
    if (this.trace.length > TRACE_CAP) this.trace.length = TRACE_CAP;
  }
}
