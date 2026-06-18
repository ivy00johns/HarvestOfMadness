/**
 * Prompt contract (§4.2) + v2 cognition prompts (deep-research-v2 §3).
 *
 * Decision prompts — System: persona + concise world rules + AgentAction
 * schema + the EXACT closing line demanding bare JSON. User: labeled v2
 * cognition sections (MEMORIES / CURRENT PLAN STEP / RELATIONSHIPS, only
 * when present on the Observation) + JSON.stringify(observation) + "What do
 * you do next?". Parsing stays defensive regardless (parse.ts).
 *
 * v2 builders (consumed by the cognition-agent): importance rating (fast
 * tier), reflection questions/insights (smart tier), daily planning (smart
 * tier). Every builder ends demanding bare output — no prose, no fences.
 */
import {
  CROPS,
  ENERGY_COSTS,
  STARTING_GOLD,
  type Landmark,
  type NeedState,
  type Observation,
} from "@contracts/types";

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
- Energy starts at 100. Exact action costs: TILL ${ENERGY_COSTS.TILL}, PLANT ${ENERGY_COSTS.PLANT}, WATER ${ENERGY_COSTS.WATER}, HARVEST ${ENERGY_COSTS.HARVEST}; moving and every other action cost 0. At 0 energy you can only walk to bed, SLEEP, or WAIT. SLEEP restores energy to 100.
- Time passes in phases: morning -> afternoon -> evening -> night. SLEEP is only possible at night at your bed, and it is the ONLY way to advance to the next day.
- BUY and SELL only work at the shop, with itemIds like "seed:parsnip" (buy) and "crop:parsnip" (sell). You need gold to buy seeds; you start with ${STARTING_GOLD} gold.
- TALK_TO another agent only when they are within 1 tile. MOVE_TO takes a map coordinate. WAIT does nothing for one beat.
- GIVE_GIFT hands 1 item from your inventory to an agent within 1 tile (builds friendship). EMOTE shows a feeling above your head; it is always allowed and changes nothing in the world.
- USE_OBJECT interacts with a nearby world object (well, notice_board, bench): USE the well to draw water and refresh yourself; USE the notice_board to read town news (you may learn about upcoming events); USE the bench to rest. Target: {"objectId": "<id>"}. Only available (in availableActions) when you are adjacent to a usable object.
- Your observation lists nearby tiles, agents, landmarks (shop, bed, water, house), your inventory, gold, energy, the result of your last action, and which actions are currently available. Choose ONLY from availableActions.
- Your observation may also include MEMORIES (relevant past experiences), a CURRENT PLAN STEP (your goal for this phase of the day), RELATIONSHIPS (how you feel about others), and NEARBY OBJECTS (well/notice_board/bench within sight). Let them guide your choice.

RESPONSE FORMAT — exactly one JSON object with this shape:
{
  "thought": string,            // brief private reasoning
  "say": string | null,         // optional short spoken line
  "action": "MOVE_TO"|"TILL"|"PLANT"|"WATER"|"HARVEST"|"BUY"|"SELL"|"TALK_TO"|"SLEEP"|"WAIT"|"GIVE_GIFT"|"EMOTE"|"USE_OBJECT",
  "target": {"x":number,"y":number} | {"itemId":string,"qty":number} | {"agentName":string} | {"agentName":string,"itemId":string,"qty":number} | {"objectId":string},  // GIVE_GIFT uses {"agentName","itemId","qty":1}; USE_OBJECT uses {"objectId":"..."}; omit for SLEEP/WAIT/EMOTE
  "goal": string,               // optional, your current standing goal
  "emotion": "neutral"|"happy"|"annoyed"|"sad"|"excited"  // optional, defaults to "neutral"
}

Example:
{"thought":"The parsnip at (5,7) is ready and I am next to it.","say":"Harvest time!","action":"HARVEST","target":{"x":5,"y":7},"goal":"sell parsnips for 1000g","emotion":"happy"}

${CLOSING_LINE}`;
}

/**
 * User prompt: v2 cognition sections (when present on the Observation) as
 * compact labeled blocks BEFORE the raw observation + action instruction.
 * With no v2 fields the output is byte-identical to v1:
 * JSON.stringify(obs) + "\nWhat do you do next?".
 */
export function buildUserPrompt(obs: Observation): string {
  const sections: string[] = [];

  if (obs.memories && obs.memories.length > 0) {
    sections.push(
      "MEMORIES:\n" +
        obs.memories
          .map((m) => `- [${m.type}, importance ${m.importance}] ${m.text}`)
          .join("\n"),
    );
  }
  // Optional chaining: callers may legitimately pass partial observations
  // (defensive parsing rules apply to prompt building too).
  if (obs.self?.currentPlanStep) {
    sections.push(`CURRENT PLAN STEP: ${obs.self.currentPlanStep}`);
  }
  if (obs.self?.relationships && obs.self.relationships.length > 0) {
    sections.push(
      "RELATIONSHIPS:\n" +
        obs.self.relationships
          .map((r) => `- ${r.name}: affinity ${r.affinity}`)
          .join("\n"),
    );
  }
  if (obs.self?.knownEvents && obs.self.knownEvents.length > 0) {
    const lines = obs.self.knownEvents.map(
      (e) =>
        `- ${e.description}, hosted by ${e.host}, on day ${e.day} (${e.phase}) at tile (${e.location.x},${e.location.y})${e.isNow ? " — HAPPENING NOW" : ""}`,
    );
    lines.push(
      "If a gathering is HAPPENING NOW, strongly prefer MOVE_TO its location to attend (or EMOTE/WAIT if already there). " +
        "If it is upcoming, mention it to nearby farmers via TALK_TO so word spreads.",
    );
    sections.push("Gatherings you know about:\n" + lines.join("\n"));
  }
  if (obs.self?.inviteTargets && obs.self.inviteTargets.length > 0) {
    const lines = obs.self.inviteTargets.map(
      (t) => `- ${t.name} at (${t.pos.x},${t.pos.y})`,
    );
    lines.push(
      "Walk to each of them (MOVE_TO) then TALK_TO to invite them.",
    );
    sections.push(
      "You are hosting a gathering — these folks haven't heard yet:\n" + lines.join("\n"),
    );
  }
  // v3 — surface nearby world objects when present.
  if (obs.nearby?.objects && obs.nearby.objects.length > 0) {
    const OBJECT_DESCRIPTIONS: Record<string, string> = {
      well:         "draw water (refreshes you)",
      notice_board: "read town news (learn about upcoming events)",
      bench:        "rest a while",
    };
    const lines = obs.nearby.objects.map(
      (o) =>
        `- ${o.kind} (id:"${o.id}") at (${o.pos.x},${o.pos.y}) — ${OBJECT_DESCRIPTIONS[o.kind] ?? "interact"}`,
    );
    if (obs.availableActions.includes("USE_OBJECT")) {
      lines.push("You are adjacent to one of these — USE_OBJECT with {\"objectId\":\"<id>\"} to interact.");
    }
    sections.push("NEARBY OBJECTS:\n" + lines.join("\n"));
  }

  const prefix = sections.length > 0 ? `${sections.join("\n")}\n` : "";
  return `${prefix}${JSON.stringify(obs)}\nWhat do you do next?`;
}

// ---------------------------------------------------------------------------
// v2 cognition prompts (deep-research-v2 §3) — consumed by cognition-agent
// ---------------------------------------------------------------------------

/**
 * Memory poignancy rating (fast tier). 1 = purely mundane routine, 10 =
 * extremely poignant. Model must answer with ONLY the integer.
 */
export function buildImportancePrompt(memoryText: string): string {
  return `On a scale of 1 to 10, where 1 is purely mundane (e.g., watering a crop, walking somewhere) and 10 is extremely poignant (e.g., a betrayal, a ruined harvest, a generous gift), rate the likely poignancy of the following memory.

MEMORY: ${memoryText}

Respond with ONLY a single integer from 1 to 10 — no prose, no fences.`;
}

/**
 * Reflection step 1 (smart tier): salient high-level questions over recent
 * memories. Model must answer with ONLY a JSON array of 3 strings.
 */
export function buildReflectionQuestionsPrompt(recentMemoryTexts: string[]): string {
  return `Here are your recent memories:

${recentMemoryTexts.map((t) => `- ${t}`).join("\n")}

Given only the information above, what are the 3 most salient high-level questions you can ask about what is happening and about the people involved?

Respond with ONLY a JSON array of exactly 3 strings — no prose, no fences.`;
}

/**
 * Reflection step 2 (smart tier): insights answering one salient question,
 * each citing the source memory ids it was inferred from. Model must answer
 * with ONLY a JSON array of {insight, sourceIds} objects.
 */
export function buildReflectionInsightsPrompt(
  question: string,
  memories: { id: string; text: string }[],
): string {
  return `QUESTION: ${question}

EVIDENCE — your memories, each with its id:

${memories.map((m) => `- [${m.id}] ${m.text}`).join("\n")}

What up to 5 high-level insights can you infer that help answer the question? Every insight must cite the ids of the source memories it was inferred from.

Respond with ONLY a JSON array of at most 5 objects shaped {"insight": string, "sourceIds": string[]} — no prose, no fences.`;
}

/**
 * v3 (Wave 2) — multi-turn conversation reply (fast tier).
 *
 * Builds the prompt for ONE in-character reply continuing an ongoing exchange.
 * The transcript tail (the most recent lines, oldest-first) gives the model
 * just enough context to stay coherent without bloating the request. The
 * speaker continues with a single short sentence and is invited to wrap up
 * naturally when it fits (so the engine's CLOSER_RE can end the conversation).
 *
 * Output is PLAIN TEXT — one spoken sentence, no quotes, no action tags.
 * Consumed by ConversationSystem; no decision-prompt JSON contract applies.
 */
export function buildReplyPrompt(opts: {
  selfPersona: string;
  selfName: string;
  otherName: string;
  affinitySummary: string;
  transcriptTail: { speaker: string; text: string }[];
}): { system: string; user: string } {
  const { selfPersona, selfName, otherName, affinitySummary, transcriptTail } =
    opts;

  const system = `You are ${selfName}, a farmer. Your persona: ${selfPersona}

You are talking with ${otherName}. Continue with ONE short in-character sentence (≤ 15 words); wrap up naturally (say goodbye) if it fits. No action tags, no quotes around your reply, just the spoken sentence.`;

  const convo =
    transcriptTail.length > 0
      ? transcriptTail.map((t) => `${t.speaker}: ${t.text}`).join("\n")
      : `${otherName} greets you.`;

  const user = `Conversation so far:
${convo}${
    affinitySummary ? `\n\nYour relationship with ${otherName}: ${affinitySummary}` : ""
  }

Your one-sentence reply as ${selfName} (plain text, no quotes):`;

  return { system, user };
}

/**
 * Morning daily plan (smart tier): exactly 4 steps, one per phase
 * morning/afternoon/evening/night. Model must answer with ONLY the JSON
 * object {steps:[{phase, goal, targetLandmark?}]}.
 *
 * Plans should mix farm work with social/leisure/errand steps so the town
 * feels inhabited: socialize at the tavern, stroll by the pond, browse the
 * market, visit a neighbor, rest at home. Persona guides the mix.
 */
export function buildDailyPlanPrompt(
  persona: string,
  day: number,
  reflectionTexts: string[],
  landmarks: Landmark[],
  goal?: string | null,
): string {
  const reflections =
    reflectionTexts.length > 0
      ? `YOUR RECENT REFLECTIONS:\n${reflectionTexts.map((t) => `- ${t}`).join("\n")}\n\n`
      : "";
  const places =
    landmarks.length > 0
      ? `LANDMARKS:\n${landmarks.map((l) => `- ${l.kind} at (${l.pos.x},${l.pos.y})`).join("\n")}\n\n`
      : "";
  // Wave 3a — goal conditioning: when a synthesized standing goal is present,
  // inject it so the plan bends toward it. Gated: omit/null → byte-identical
  // to the v2 prompt (prompts-v2 buildDailyPlanPrompt tests stay green).
  const goalBlock =
    goal && goal.trim().length > 0 ? `YOUR CURRENT GOAL: ${goal.trim()}\n\n` : "";
  return `You are a farmer in a tiny farming world. It is the morning of day ${day}.

PERSONA:
${persona}

${goalBlock}${reflections}${places}Plan your day. Produce exactly 4 steps, one for each phase in this order: morning, afternoon, evening, night. Each step has a short concrete goal. The plan should feel VARIED and persona-driven — mix farm work with social and leisure activities:

- A social persona should find time at the tavern or chatting with farmers.
- A dreamy or wandering persona should stroll by the pond or wander the paths.
- A frugal persona should browse the market, check prices, haggle.
- A grumbling or methodical persona sticks mostly to the field but may visit the tavern in the evening.
- The morning is usually for farm work; afternoon/evening can include socializing, the market, or the pond.
- The night step should end at the bed to sleep.

"targetLandmark" is optional and must be one of "shop", "bed", "water", "house", "tavern" when used.

Respond with ONLY one JSON object shaped {"steps":[{"phase":"morning"|"afternoon"|"evening"|"night","goal":string,"targetLandmark":string?}]} with exactly 4 steps — no prose, no fences.`;
}

// ---------------------------------------------------------------------------
// Wave 3a — needs-driven goal synthesis (smart tier). PLAIN TEXT, one line.
// ---------------------------------------------------------------------------

/** Drive keys in display order; the higher the value the more pressing. */
const GOAL_DRIVE_KEYS: (keyof NeedState)[] = [
  "energy",
  "wealth",
  "social",
  "novelty",
  "purpose",
];

/**
 * Standing-goal synthesis (smart tier): turn the agent's intrinsic drives +
 * recent memories into ONE short standing goal. Output is PLAIN TEXT — a
 * single sentence, no JSON, no quotes, no fences (consumed by GoalsSystem,
 * which sanitizes to one line ≤120 chars and falls back to mockGoal on
 * error/empty/over-long). Drives are listed strongest-first so the model
 * leads with the most pressing need.
 */
export function buildGoalPrompt(
  persona: string,
  needs: NeedState,
  topMemories: string[],
): string {
  const drives = GOAL_DRIVE_KEYS.slice()
    .sort((a, b) => (needs?.[b] ?? 0) - (needs?.[a] ?? 0))
    .map((k) => `- ${k}: ${(needs?.[k] ?? 0).toFixed(2)}`)
    .join("\n");
  const memories =
    topMemories.length > 0
      ? `\nRECENT MEMORIES:\n${topMemories.map((m) => `- ${m}`).join("\n")}\n`
      : "";
  return `You are a farmer. Persona: ${persona}

YOUR INTRINSIC DRIVES (0 = satisfied, 1 = most pressing), strongest first:
${drives}
${memories}
Given the drives and memories above, what is the single standing goal that should guide your day right now? Lead with your most pressing drive.

Respond with ONLY one sentence (≤ 15 words) as plain text — no quotes, no JSON, no fences.`;
}
