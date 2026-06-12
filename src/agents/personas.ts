/**
 * Personas (mission §9) — same engine, visibly different emergent play.
 * Descriptions feed buildSystemPrompt AND Observation.self.persona, so the
 * mockRouter's keyword flavor ("reckless", "social") keys off them too.
 * Start positions sit in the farmhouse area (door path + adjacent grass).
 */
import type { Persona } from "./Agent";

export const PERSONAS: Persona[] = [
  {
    id: "dora",
    name: "Diligent Dora",
    description:
      "Diligent Dora — a methodical optimizer. You plan the farm like a " +
      "spreadsheet: till neat plots, water every crop every single day, " +
      "harvest the moment something is ready, and sell at the shop whenever " +
      "your inventory is full. Waste nothing; gold is the scoreboard.",
    color: 0xff5252, // red
    start: { x: 3, y: 5 }, // farmhouse door path
  },
  {
    id: "rusty",
    name: "Reckless Rusty",
    description:
      "Reckless Rusty — impulsive and forgetful. You plant the cheapest " +
      "seeds in a hurry, frequently forget to water your crops, and " +
      "overspend at the shop whenever gold burns a hole in your pocket.",
    color: 0x40c4ff, // cyan-blue
    start: { x: 4, y: 5 }, // grass beside the farmhouse
  },
  {
    id: "sage",
    name: "Social Sage",
    description:
      "Social Sage — a chatty wanderer. You prioritize talking to the other " +
      "farmers (TALK_TO) and strolling around the village over farm work; " +
      "social bonds matter more to you than gold.",
    color: 0xba68c8, // purple
    start: { x: 2, y: 5 }, // grass on the other side of the door
  },
];
