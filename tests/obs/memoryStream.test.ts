/**
 * B-7 memory-stream seam (src/obs/wiring.ts → readMemoryStream): the inspector's
 * one new data seam exposes the REAL cognition memory store (no fabrication).
 * Asserts it returns an agent's actual appended memories, an honest empty array
 * when the agent has none, and [] when cognition is absent (mock / server down).
 * Uses a real CognitionSystem (mock mode) with its real InMemoryMemoryStore —
 * no store internals are touched, only the additive read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryType } from "@contracts/types";
import { CognitionSystem } from "../../src/agents/Cognition";
import { getEventBus, resetEventBusForTests } from "../../src/agents/events";
import { resetWorldForTests } from "../../src/world/instance";
import { readMemoryStream } from "../../src/obs/wiring";

let cognition: CognitionSystem;

beforeEach(() => {
  resetWorldForTests();
  resetEventBusForTests();
  cognition = new CognitionSystem({ bus: getEventBus() }); // mock mode (no VITE_MODEL_MODE)
});

async function append(name: string, type: MemoryType, text: string, importance: number) {
  return cognition.memory.append({
    agentName: name,
    type,
    text,
    importance,
    createdAt: { day: 1, phase: "morning" },
  });
}

describe("readMemoryStream seam", () => {
  it("returns the agent's REAL appended memory entries (no fabrication)", async () => {
    await append("Alice", "observation", "saw a ripe parsnip", 4);
    await append("Alice", "reflection", "I should harvest more", 7);
    await append("Bob", "plan", "go to the shop", 5); // a different agent

    const alice = readMemoryStream(cognition, "Alice");
    expect(alice).toHaveLength(2);
    expect(alice.map((m) => m.text)).toEqual([
      "saw a ripe parsnip",
      "I should harvest more",
    ]);
    expect(alice.map((m) => m.type)).toEqual(["observation", "reflection"]);
    expect(alice.map((m) => m.importance)).toEqual([4, 7]);
    // Real store entries carry real ids/agentName — not a fabricated shell.
    expect(alice.every((m) => m.agentName === "Alice" && m.id.length > 0)).toBe(true);

    // Scoped to the named agent — Bob's plan never leaks into Alice's stream.
    expect(readMemoryStream(cognition, "Bob").map((m) => m.text)).toEqual([
      "go to the shop",
    ]);
  });

  it("returns a fresh array snapshot, not the live store array", async () => {
    await append("Alice", "observation", "first", 3);
    const a = readMemoryStream(cognition, "Alice");
    const b = readMemoryStream(cognition, "Alice");
    expect(a).not.toBe(b); // MemoryStore.all() defensively copies
    expect(a).toEqual(b);
  });

  it("honest empty state: [] when the agent has no memories", () => {
    expect(readMemoryStream(cognition, "Nobody")).toEqual([]);
  });

  it("honest empty state: [] when cognition is absent (mock / server down)", () => {
    expect(readMemoryStream(null, "Alice")).toEqual([]);
  });
});
