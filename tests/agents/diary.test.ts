/**
 * DiarySystem (additive, modeled on the reflection engine) — deterministic mock
 * generation, one-entry-per-agent-per-day, entries()/latest() reads, a sane
 * empty-memory entry, the `diary` bus event, and never-throws-on-garbage.
 */
import { describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  LlmRequest,
  Router,
  WorldEvent,
} from "@contracts/types";
import { InMemoryMemoryStore } from "../../src/agents/memory/MemoryStore";
import { DiarySystem } from "../../src/agents/Diary";

const A = "Dora";

function makeBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => {
      events.push({ ...e, seq: ++seq, ts: Date.now() });
    },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

interface Harness {
  store: InMemoryMemoryStore;
  diary: DiarySystem;
  events: WorldEvent[];
  now: { stamp: GameStamp };
  calls: LlmRequest[];
}

function makeHarness(opts: { live?: boolean; router?: Router } = {}): Harness {
  const now = { stamp: { day: 1, phase: "morning" } as GameStamp };
  const store = new InMemoryMemoryStore({ now: () => now.stamp });
  const { bus, events } = makeBus();
  const calls: LlmRequest[] = [];
  const router: Router = async (req) => {
    calls.push(req);
    return opts.router
      ? opts.router(req)
      : { raw: "", model: "none", latencyMs: 0, error: "no router" };
  };
  const diary = new DiarySystem({
    store,
    bus,
    live: () => opts.live ?? false,
    router,
    now: () => now.stamp,
  });
  return { store, diary, events, now, calls };
}

async function seedDay(h: Harness, day: number, texts: string[]): Promise<void> {
  for (const text of texts) {
    await h.store.append({
      agentName: A,
      type: "observation",
      text,
      importance: 3,
      createdAt: { day, phase: "afternoon" },
    });
  }
}

describe("DiarySystem — mock generation", () => {
  it("writes a deterministic first-person entry for the day that just ended", async () => {
    const h = makeHarness();
    await seedDay(h, 1, ["watered the parsnip", "sold 3 parsnips", "Rusty gave me a gift"]);
    h.now.stamp = { day: 2, phase: "morning" }; // day 1 just ended

    const a = await h.diary.writeEntry(A);
    expect(a).not.toBeNull();
    expect(a!.day).toBe(1); // the day that just ended
    expect(a!.text.length).toBeGreaterThan(0);

    // deterministic — same memories + day reproduce the same text
    const h2 = makeHarness();
    await seedDay(h2, 1, ["watered the parsnip", "sold 3 parsnips", "Rusty gave me a gift"]);
    h2.now.stamp = { day: 2, phase: "morning" };
    const b = await h2.diary.writeEntry(A);
    expect(b!.text).toBe(a!.text);
  });

  it("emits a `diary` bus event carrying the entry", async () => {
    const h = makeHarness();
    await seedDay(h, 1, ["tilled the east plot"]);
    h.now.stamp = { day: 2, phase: "morning" };
    const entry = await h.diary.writeEntry(A);

    const evts = h.events.filter((e) => e.kind === "diary");
    expect(evts).toHaveLength(1);
    expect(evts[0].agentName).toBe(A);
    expect(evts[0].text).toContain(A);
    expect(evts[0].payload?.text).toBe(entry!.text);
    expect(evts[0].payload?.day).toBe(1);
  });
});

describe("DiarySystem — one entry per agent per day", () => {
  it("does not double-write for the same just-ended day", async () => {
    const h = makeHarness();
    await seedDay(h, 1, ["planted seeds"]);
    h.now.stamp = { day: 2, phase: "morning" };

    const first = await h.diary.writeEntry(A);
    expect(first).not.toBeNull();
    const second = await h.diary.writeEntry(A); // same day already journaled
    expect(second).toBeNull();

    expect(h.diary.entries(A)).toHaveLength(1);
    expect(h.events.filter((e) => e.kind === "diary")).toHaveLength(1);
  });

  it("writes a fresh entry once a new day ends", async () => {
    const h = makeHarness();
    await seedDay(h, 1, ["planted seeds"]);
    h.now.stamp = { day: 2, phase: "morning" };
    expect(await h.diary.writeEntry(A)).not.toBeNull();

    await seedDay(h, 2, ["harvested the parsnips"]);
    h.now.stamp = { day: 3, phase: "morning" };
    const day2 = await h.diary.writeEntry(A);
    expect(day2).not.toBeNull();
    expect(day2!.day).toBe(2);
    expect(h.diary.entries(A)).toHaveLength(2);
  });
});

describe("DiarySystem — entries() / latest()", () => {
  it("returns entries oldest-first and the newest via latest()", async () => {
    const h = makeHarness();
    await seedDay(h, 1, ["day one work"]);
    h.now.stamp = { day: 2, phase: "morning" };
    await h.diary.writeEntry(A);
    await seedDay(h, 2, ["day two work"]);
    h.now.stamp = { day: 3, phase: "morning" };
    await h.diary.writeEntry(A);

    const entries = h.diary.entries(A);
    expect(entries.map((e) => e.day)).toEqual([1, 2]);
    expect(h.diary.latest(A)!.day).toBe(2);

    // defensive copy — mutating the returned array doesn't corrupt the store
    entries.push({ day: 99, phase: "morning", text: "x" });
    expect(h.diary.entries(A)).toHaveLength(2);
  });

  it("entries()/latest() are empty/null for an unknown agent", () => {
    const h = makeHarness();
    expect(h.diary.entries("Nobody")).toEqual([]);
    expect(h.diary.latest("Nobody")).toBeNull();
  });
});

describe("DiarySystem — empty memory + live + robustness", () => {
  it("yields a sane entry when the agent has no memories for the day", async () => {
    const h = makeHarness();
    h.now.stamp = { day: 2, phase: "morning" };
    const entry = await h.diary.writeEntry(A);
    expect(entry).not.toBeNull();
    expect(entry!.text.length).toBeGreaterThan(0);
  });

  it("live path uses ONE fast-tier call and sanitizes the entry", async () => {
    const router: Router = async (req) => {
      expect(req.tier).toBe("fast");
      return {
        raw: '```\n"Today I worked hard in the fields and felt proud."\n```',
        model: "live",
        latencyMs: 1,
      };
    };
    const h = makeHarness({ live: true, router });
    await seedDay(h, 1, ["watered the parsnip"]);
    h.now.stamp = { day: 2, phase: "morning" };
    const entry = await h.diary.writeEntry(A);
    expect(entry).not.toBeNull();
    expect(h.calls).toHaveLength(1); // exactly one live call
    expect(entry!.text).toBe("Today I worked hard in the fields and felt proud.");
  });

  it("degrades to the mock entry when the live router errors", async () => {
    const router: Router = async () => ({
      raw: "",
      model: "x",
      latencyMs: 1,
      error: "upstream_error: 502",
    });
    const h = makeHarness({ live: true, router });
    await seedDay(h, 1, ["sold parsnips"]);
    h.now.stamp = { day: 2, phase: "morning" };
    const entry = await h.diary.writeEntry(A);
    expect(entry).not.toBeNull();
    expect(entry!.text.length).toBeGreaterThan(0);
  });

  it("never throws even when the store / bus misbehave", async () => {
    const bus: EventBus = {
      emit: () => {
        throw new Error("bus boom");
      },
      on: () => () => {},
      recent: () => [],
    };
    const badStore = {
      all: () => {
        throw new Error("store boom");
      },
    } as unknown as InMemoryMemoryStore;
    const diary = new DiarySystem({
      store: badStore,
      bus,
      live: () => false,
      router: async () => ({ raw: "", model: "m", latencyMs: 0 }),
      now: () => ({ day: 2, phase: "morning" }),
    });
    await expect(diary.writeEntry(A)).resolves.toBeNull();
    expect(diary.entries(A)).toEqual([]);
    expect(diary.latest(A)).toBeNull();
  });
});
