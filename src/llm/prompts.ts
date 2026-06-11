/**
 * Prompt contract (§4.2).
 *
 * System: persona + concise world rules + AgentAction schema + the EXACT
 * closing line demanding bare JSON. User: JSON.stringify(observation) +
 * "What do you do next?". Parsing stays defensive regardless (parse.ts).
 */
import { CROPS, type Observation } from "@contracts/types";

const CLOSING_LINE = "Respond with ONLY one JSON object — no prose, no fences.";

function cropTable(): string {
  return (Object.keys(CROPS) as Array<keyof typeof CROPS>)
    .map((kind) => {
      const c = CROPS[kind];
      return `- ${kind}: grows in ${c.days} days, seed costs ${c.seedCost}g (seed:${kind}), crop sells for ${c.sellPrice}g (crop:${kind})`;
    })
    .join("\n");
}

export function buildSystemPrompt(personaDescription: string): string {
  return `You are an autonomous farmer in a tiny top-down farming world.

PERSONA:
${personaDescription}

WORLD RULES:
- The map is a grid of tiles: grass, path, water, tilled, soil, building, bedTile, shopTile, wall. You walk on passable tiles; walls, water and buildings block you.
- Farming sequence: TILL a soil/grass tile -> PLANT a seed on the tilled tile -> WATER it each day -> when ready, HARVEST the crop -> SELL it at the shop.
- Crops (days to grow, prices):
${cropTable()}
- A crop only advances one growth stage overnight if it was watered that day. Watering resets every morning.
- Energy starts at 100. Each field action (TILL/PLANT/WATER/HARVEST) costs about 3 energy. At 0 energy you can only walk to bed, SLEEP, or WAIT. SLEEP restores energy.
- Time passes in phases: morning -> afternoon -> evening -> night. SLEEP is only possible at night at your bed, and it is the ONLY way to advance to the next day.
- BUY and SELL only work at the shop, with itemIds like "seed:parsnip" (buy) and "crop:parsnip" (sell). You need gold to buy seeds.
- TALK_TO another agent only when they are within 1 tile. MOVE_TO takes a map coordinate. WAIT does nothing for one beat.
- Your observation lists nearby tiles, agents, landmarks (shop, bed, water, house), your inventory, gold, energy, the result of your last action, and which actions are currently available. Choose ONLY from availableActions.

RESPONSE FORMAT — exactly one JSON object with this shape:
{
  "thought": string,            // brief private reasoning
  "say": string | null,         // optional short spoken line
  "action": "MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"|"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT",
  "target": {"x":number,"y":number} | {"itemId":string,"qty":number} | {"agentName":string},  // omit for SLEEP/WAIT
  "goal": string                // optional, your current standing goal
}

Example:
{"thought":"The parsnip at (5,7) is ready and I am next to it.","say":"Harvest time!","action":"HARVEST","target":{"x":5,"y":7},"goal":"sell parsnips for 1000g"}

${CLOSING_LINE}`;
}

export function buildUserPrompt(obs: Observation): string {
  return `${JSON.stringify(obs)}\nWhat do you do next?`;
}
