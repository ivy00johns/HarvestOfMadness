/**
 * Observation assembly (§4.1) — the agent's honest view of the world.
 *
 * `availableActions` is computed truthfully against current world state
 * (domain rule 3 energy floor included) so prompts never advertise actions
 * the executor would reject on principle. The executor still re-validates
 * everything at execution time (rule 4).
 */
import type { ActionType, Observation, Vec2, WorldApi } from "@contracts/types";
import { OBSERVATION_RADIUS } from "@contracts/types";
import { isTypeTillable } from "../world/Tile";
import type { Agent } from "./Agent";

/** Chebyshev distance — "within 1 tile" (TALK_TO range, matches mockRouter). */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Honest availability (§4.4 preconditions + domain rule 3):
 * - MOVE_TO / WAIT: always.
 * - SLEEP: standing on a bedTile at night (works at any energy).
 * - At energy 0 nothing else is offered (rule 3 floor).
 * - Field actions (TILL/PLANT/WATER/HARVEST): energy>0 + a plausible target
 *   on a 4-adjacent (or own) tile; PLANT also needs a held seed.
 * - BUY/SELL: standing on a shopTile, with gold (cheapest seed) / a sellable
 *   item respectively.
 * - TALK_TO: another agent within 1 tile (Chebyshev).
 * - GIVE_GIFT (v2): another agent 4-adjacent AND at least one held item.
 * - EMOTE (v2): always legal per rule 8 — but the rule-3 energy floor is
 *   explicit ("only MOVE_TO/SLEEP/WAIT"), so at energy 0 it is not OFFERED
 *   here; the executor still accepts it (rule 8 wins at execution time).
 */
export function computeAvailableActions(
  agent: Agent,
  world: WorldApi,
  others: Agent[],
): ActionType[] {
  const here = world.getTile(agent.pos.x, agent.pos.y);
  const night = world.time().phase === "night";
  const onBed = here?.type === "bedTile";
  const sleepOk = onBed && night;

  const out: ActionType[] = ["MOVE_TO"];

  if (agent.energy > 0) {
    // 4-adjacent tiles + the tile under the agent (world.isAdjacent semantics).
    const adjacent = world
      .tilesInRadius(agent.pos, 1)
      .filter((t) => world.isAdjacent(agent.pos, t));

    if (adjacent.some((t) => isTypeTillable(t.type) && !t.crop)) {
      out.push("TILL");
    }
    if (
      agent.firstSeed() !== null &&
      adjacent.some((t) => t.type === "tilled" && !t.crop)
    ) {
      out.push("PLANT");
    }
    if (adjacent.some((t) => t.crop && !t.crop.watered)) {
      out.push("WATER");
    }
    if (adjacent.some((t) => t.crop?.ready)) {
      out.push("HARVEST");
    }

    if (here?.type === "shopTile") {
      const buys = world.buyPrices();
      const cheapest = Math.min(...Object.values(buys));
      if (agent.gold >= cheapest) out.push("BUY");
      const sells = world.sellPrices();
      if (agent.inventory.some((i) => i.qty > 0 && sells[i.itemId] !== undefined)) {
        out.push("SELL");
      }
    }

    if (
      others.some(
        (o) => o.name !== agent.name && chebyshev(agent.pos, o.pos) <= 1,
      )
    ) {
      out.push("TALK_TO");
    }

    // v2 — gift needs a 4-adjacent receiver and something to give.
    if (
      agent.inventory.some((i) => i.qty > 0) &&
      others.some(
        (o) => o.name !== agent.name && world.isAdjacent(agent.pos, o.pos),
      )
    ) {
      out.push("GIVE_GIFT");
    }

    // v2 — EMOTE rides inside the energy>0 block (see doc comment above).
    out.push("EMOTE");
  }

  if (sleepOk) out.push("SLEEP");
  out.push("WAIT");
  return out;
}

export function buildObservation(
  agent: Agent,
  world: WorldApi,
  others: Agent[],
): Observation {
  const visible = others.filter(
    (o) =>
      o.name !== agent.name &&
      chebyshev(agent.pos, o.pos) <= OBSERVATION_RADIUS,
  );

  return {
    self: {
      name: agent.name,
      persona: agent.persona.description,
      role: agent.role,
      pos: { ...agent.pos },
      energy: agent.energy,
      gold: agent.gold,
      inventory: agent.inventory.map((i) => ({ ...i })),
      goal: agent.goal,
    },
    time: world.time(),
    nearby: {
      tiles: world.tilesInRadius(agent.pos, OBSERVATION_RADIUS).map((t) => ({
        x: t.x,
        y: t.y,
        type: t.type,
        ...(t.crop
          ? {
              crop: {
                kind: t.crop.kind,
                stage: t.crop.stage,
                watered: t.crop.watered,
                ready: t.crop.ready,
              },
            }
          : {}),
      })),
      agents: visible.map((o) => ({
        name: o.name,
        pos: { ...o.pos },
        lastSeenDoing: o.lastSeenDoing,
      })),
      // Landmarks are global knowledge (the agent lives here) — required so
      // the heuristic/LLM can navigate to shop/bed from anywhere on the map.
      landmarks: world.landmarks(),
    },
    lastAction: agent.lastAction ? { ...agent.lastAction } : null,
    availableActions: computeAvailableActions(agent, world, others),
    economy: { sells: world.sellPrices(), buys: world.buyPrices() },
  };
}
