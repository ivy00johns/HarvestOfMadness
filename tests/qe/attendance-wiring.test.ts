/**
 * Phase C · Slice 1 — attendance WIRING proof (end-to-end boundary).
 *
 * The pure policy in `src/agents/attendance.ts` is exercised by
 * `attendance-distance.test.ts`. THIS test proves the policy is actually WIRED
 * across the Cognition→mockRouter→decide() boundary: that the additive
 * Observation field `homePathTiles` survives `normalizeObservation`
 * (mock.ts:977, run on every Observation before decide()) and reaches the
 * attendance gate (mock.ts:430).
 *
 * Regression target: normalizeObservation previously rebuilt each knownEvents
 * entry into a fresh `se` object that copied only id/host/location/day/phase/
 * description/isNow — DROPPING homePathTiles. With it dropped, the gate read
 * `nowEvent.homePathTiles ?? 0` ⇒ attendanceProbability(0) = 1 ⇒ willAttend
 * always true ⇒ EVERY knower attended unconditionally and the distance-weighted
 * gate was a dead no-op end-to-end.
 *
 * Method: build a raw Observation for a NON-host, NON-adjacent agent whose only
 * isNow knownEvent sits far away (homePathTiles = 99999, deep past
 * ATTEND_DECAY ⇒ probability floors at ATTEND_FLOOR = 0.05). JSON.stringify it
 * into the mockRouter user field, await mockRouter, and read
 * result.parsed.action. Sweep all 12 real persona names: at prob ≈ 0.05 almost
 * every coin lands above it, so the MOVE_TO count must be a STRICT MINORITY
 * (< half). A NEAR agent (homePathTiles = 3 ⇒ prob ≈ 0.985) must still MOVE_TO.
 *
 * Against the dead-gate code this FAILS: with homePathTiles dropped every
 * persona MOVE_TOs (12/12), so the strict-minority assertion is red.
 */

import { describe, expect, it } from "vitest";
import type { Observation } from "@contracts/types";
import { mockRouter } from "../../src/llm/mock";
import { PERSONAS } from "../../src/agents/personas";

const PERSONA_NAMES = PERSONAS.map((p) => p.name);

// Far event the agent is NOT adjacent to (agent at origin, event across the map).
const FAR_EVENT_POS = { x: 130, y: 90 };
const AGENT_POS = { x: 1, y: 1 };
const EVENT_ID = "party-d2";
const EVENT_DAY = 2;

/**
 * A minimal-but-valid raw Observation for `name`, carrying a single isNow event
 * at FAR_EVENT_POS with the given home→event A* length, and MOVE_TO available.
 * NON-host (host is a different agent) and NON-adjacent (agent at origin).
 */
function buildObs(name: string, homePathTiles: number): Observation {
  return {
    self: {
      name,
      persona: "test",
      role: "farmer",
      pos: { ...AGENT_POS },
      energy: 1,
      gold: 0,
      inventory: [],
      goal: null,
      knownEvents: [
        {
          id: EVENT_ID,
          host: "Some Other Host",
          location: { ...FAR_EVENT_POS },
          day: EVENT_DAY,
          phase: "evening",
          description: "a gathering at the tavern",
          isNow: true,
          homePathTiles,
        },
      ],
    },
    time: { day: EVENT_DAY, phase: "evening" },
    nearby: { tiles: [], agents: [], landmarks: [] },
    lastAction: null,
    availableActions: ["MOVE_TO", "EMOTE", "WAIT", "TALK_TO"],
    economy: { sells: {}, buys: {} },
  };
}

async function actionFor(name: string, homePathTiles: number): Promise<string> {
  const obs = buildObs(name, homePathTiles);
  const res = await mockRouter({ agentId: name, system: "", user: JSON.stringify(obs) });
  expect(res.parsed, `mockRouter returned no parsed action for ${name}`).toBeDefined();
  return res.parsed!.action;
}

describe("attendance gate wiring (Cognition→mockRouter boundary)", () => {
  it("FAR agents (homePathTiles ≫ ATTEND_DECAY) — MOVE_TO is a strict minority", async () => {
    let moved = 0;
    const movers: string[] = [];
    for (const name of PERSONA_NAMES) {
      const action = await actionFor(name, 99999);
      if (action === "MOVE_TO") {
        moved++;
        movers.push(name);
      }
    }
    // At probability ≈ ATTEND_FLOOR (0.05), almost no coin clears the gate, so
    // the attenders must be a STRICT MINORITY of the 12 personas. Against the
    // dead-gate code (homePathTiles dropped ⇒ prob 1) ALL 12 move ⇒ this fails.
    expect(
      moved,
      `Expected a strict minority (< ${PERSONA_NAMES.length / 2}) of far agents to MOVE_TO; ` +
        `got ${moved}/${PERSONA_NAMES.length}: ${movers.join(", ")}. ` +
        `If this is ${PERSONA_NAMES.length}/${PERSONA_NAMES.length}, the gate is a dead no-op ` +
        `(homePathTiles not propagated through normalizeObservation).`,
    ).toBeLessThan(PERSONA_NAMES.length / 2);
  });

  it("a NEAR agent (small homePathTiles) still MOVE_TOs to the event", async () => {
    // prob(3) ≈ 0.985 ⇒ essentially every coin clears the gate. We assert it for
    // a known-near persona, proving the gate is additive (near ⇒ attend), not a
    // blanket suppressor.
    const action = await actionFor("Social Sage", 3);
    expect(action).toBe("MOVE_TO");
  });
});
