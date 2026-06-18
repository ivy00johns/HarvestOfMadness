/**
 * Fix C (Wave 3c, 429-storm resilience): MemoryStore micro-batches the
 * fire-and-forget embedding writes. A burst of N synchronous append()s in one
 * tick coalesces into a SINGLE embedTexts(texts) call (one POST /api/embeddings
 * instead of N), each entry getting its vector back by index; >32 writes split
 * into ceil(N/32) calls (the proxy cap from embed.ts). append()'s signature and
 * the rule-10 fire-and-forget / never-throw contract are unchanged, and stop()
 * clears the pending batch timer so vitest sees no open handle.
 */
import { describe, expect, it, vi } from "vitest";
import type { GameStamp } from "@contracts/types";
import { InMemoryMemoryStore } from "../../src/agents/memory/MemoryStore";

const A = "Tester";

function stamp(day: number, phase: GameStamp["phase"] = "morning"): GameStamp {
  return { day, phase };
}

function obsInput(text: string, importance: number) {
  return { agentName: A, type: "observation" as const, text, importance, createdAt: stamp(1) };
}

/** Drain the batch flush timer (default coalescing window) + the embed microtasks. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("MemoryStore embedding micro-batch (Fix C)", () => {
  it("coalesces a burst of synchronous appends into ONE embedTexts call", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((_t, i) => [i, i + 1]));
    const store = new InMemoryMemoryStore({ now: () => stamp(1), live: () => true, embed });

    // 6 writes in the same tick — do NOT await between them.
    const entries = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.append(obsInput(`m${i}`, 2))),
    );
    await flush();

    // Exactly ONE batched POST, carrying all six texts in order.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);

    // Each entry got its vector assigned by index.
    entries.forEach((e, i) => expect(e.embedding).toEqual([i, i + 1]));

    store.stop();
  });

  it("splits >32 writes into ceil(n/32) batched calls", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const store = new InMemoryMemoryStore({ now: () => stamp(1), live: () => true, embed });

    const N = 70; // ceil(70/32) = 3 batches (32 + 32 + 6)
    const entries = await Promise.all(
      Array.from({ length: N }, (_, i) => store.append(obsInput(`m${i}`, 2))),
    );
    await flush();

    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls[0][0]).toHaveLength(32);
    expect(embed.mock.calls[1][0]).toHaveLength(32);
    expect(embed.mock.calls[2][0]).toHaveLength(6);
    for (const e of entries) expect(e.embedding).toEqual([1, 0]);

    store.stop();
  });

  it("never issues an embed request in mock mode (live=false)", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const store = new InMemoryMemoryStore({ now: () => stamp(1), live: () => false, embed });

    const e = await store.append(obsInput("solo", 2));
    await flush();

    expect(embed).not.toHaveBeenCalled();
    expect(e.embedding).toBeUndefined(); // works without an embedding (relevance 0)
    store.stop();
  });

  it("a thrown embed never surfaces and leaves entries functional (rule 10)", async () => {
    const store = new InMemoryMemoryStore({
      now: () => stamp(1),
      live: () => true,
      embed: async () => {
        throw new Error("endpoint down");
      },
    });

    const e = await store.append(obsInput("still fine", 2));
    await expect(flush()).resolves.toBeUndefined(); // no unhandled rejection
    expect(e.embedding).toBeUndefined();
    store.stop();
  });

  it("stop() clears the pending batch timer (no flush after teardown)", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const store = new InMemoryMemoryStore({ now: () => stamp(1), live: () => true, embed });

    await store.append(obsInput("queued", 2)); // schedules the batch timer
    store.stop(); // cancel before it fires
    await flush();

    expect(embed).not.toHaveBeenCalled();
  });
});
