/**
 * Multi-turn conversation engine (v3 Wave 2) — the back-and-forth proof.
 *
 * Coverage (spec §5):
 *  - cap: a conversation has 2..MAX_TURNS (4) utterances including A's opener;
 *  - alternation: turns strictly alternate A, B, A, …;
 *  - closer: a CLOSER_RE reply ends the exchange early (< MAX_TURNS);
 *  - affinity: a full 4-turn convo still yields exactly +2/side (engine adds 0);
 *  - memory: exactly ONE "I told Alice:" pair per conversation (not per turn);
 *  - determinism: two mock runs produce byte-identical turns[];
 *  - graceful fallback: a live router error yields mock-filled turns, no throw;
 *  - earshot: Chebyshev > 1 → no conversation at all (guard checked once).
 *  - mockReply turnIndex 0 is byte-identical to the v2 single-utterance output.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  LlmResponse,
  Router,
  Vec2,
  WorldEvent,
} from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { MAX_TURNS, mockReply } from "../../src/agents/Conversation";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeStampBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => { events.push({ ...e, seq: ++seq, ts: Date.now() }); },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

function makeAgent(name: string, persona: string, pos: Vec2): Agent {
  return new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: persona,
    color: 0xffffff,
    start: pos,
  });
}

interface Harness {
  cog: CognitionSystem;
  events: WorldEvent[];
}

function makeCognition(opts?: { live?: boolean; router?: Router }): Harness {
  const { bus, events } = makeStampBus();
  const now: () => GameStamp = () => ({ day: 1, phase: "morning" });
  const cog = new CognitionSystem({
    bus,
    live: () => opts?.live ?? false,
    now,
    ...(opts?.router ? { router: opts.router } : {}),
  });
  return { cog, events };
}

function convTurns(events: WorldEvent[]): { speaker: string; text: string }[] {
  const e = events.find((x) => x.kind === "conversation");
  return (e?.payload?.turns as { speaker: string; text: string }[]) ?? [];
}

const SETTLE = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => { resetWorldForTests(); });

// ---------------------------------------------------------------------------
// Cap + alternation
// ---------------------------------------------------------------------------

describe("multi-turn — cap and alternation", () => {
  it("a conversation has between 2 and MAX_TURNS utterances", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "social chatty neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Morning!");
    await SETTLE();

    const turns = convTurns(events);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(MAX_TURNS).toBe(4);
  });

  it("turns strictly alternate A, B, A, …", async () => {
    const { cog, events } = makeCognition();
    // Non-closing personas (grumbling B + plain A) so the convo runs to the cap.
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "How's the harvest?");
    await SETTLE();

    const turns = convTurns(events);
    expect(turns.length).toBe(MAX_TURNS); // neither persona closes early
    expect(turns.map((t) => t.speaker)).toEqual(["Alice", "Bob", "Alice", "Bob"]);
  });
});

// ---------------------------------------------------------------------------
// Closer ends early
// ---------------------------------------------------------------------------

describe("multi-turn — a closer ends the exchange early", () => {
  it("a closing responder ends the conversation below the cap", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    // The social greeting ("Always good to see you") matches CLOSER_RE ("see you").
    const ben = makeAgent("Ben", "social chatty farmer", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(ben);

    cog.onTalk(alice, ben, "Got a minute to chat?");
    await SETTLE();

    const turns = convTurns(events);
    // Ben's turn-1 reply closes → exactly 2 utterances (A opener + B closer).
    expect(turns.length).toBe(2);
    expect(turns.length).toBeLessThan(MAX_TURNS);
    expect(/\b(bye|goodbye|farewell|see you|take care|later)\b/i.test(turns[1].text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Affinity — engine adds zero
// ---------------------------------------------------------------------------

describe("multi-turn — affinity is not multiplied by extra turns", () => {
  it("a 4-turn conversation still yields exactly +2 affinity per side", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    // Grumbling B never closes early, so the convo runs the full 4 turns.
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Tell me everything!");
    await SETTLE();

    expect(convTurns(events).length).toBe(4); // genuinely a 4-turn exchange
    // The engine touches affinity ZERO times; onTalk's single +2/side stands.
    expect(cog.relationships.get("Alice", "Bob")?.affinity).toBe(2);
    expect(cog.relationships.get("Bob", "Alice")?.affinity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Memory — exactly ONE pair per conversation
// ---------------------------------------------------------------------------

describe("multi-turn — exactly one legacy memory pair per conversation", () => {
  it("B has exactly one 'I told Alice:' memory after a full 4-turn convo", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    // Grumbling B runs the full 4 turns — still ONE memory pair, not per-turn.
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Long chat ahead?");
    await SETTLE();

    expect(convTurns(events).length).toBe(4);
    const told = cog.memory.all("Bob").filter((m) => m.text.startsWith("I told Alice:"));
    expect(told).toHaveLength(1);
    const heard = cog.memory.all("Alice").filter((m) => m.text.startsWith("Bob replied:"));
    expect(heard).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism — two mock runs are byte-identical
// ---------------------------------------------------------------------------

describe("multi-turn — mock determinism", () => {
  it("two runs of the same conversation produce identical turns[]", async () => {
    const run = async () => {
      resetWorldForTests();
      const { cog, events } = makeCognition();
      const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
      const bob = makeAgent("Bob", "social chatty neighbor", { x: 5, y: 6 });
      cog.registerAgent(alice);
      cog.registerAgent(bob);
      cog.onTalk(alice, bob, "Same opener every time.");
      await SETTLE();
      return convTurns(events);
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
  });

  it("mockReply turnIndex 0 is byte-identical to the v2 default output", () => {
    // The default arg keeps the v2 single-utterance template byte-for-byte.
    expect(mockReply("social chatty farmer", "Alice", "hi")).toBe(
      mockReply("social chatty farmer", "Alice", "hi", 0),
    );
    expect(mockReply("social chatty farmer", "Alice", "hi", 0)).toBe(
      "Always good to see you, Alice!",
    );
    expect(mockReply("grumbling gruff elder", "Alice", "hi", 0)).toBe("Hmph. If you say so.");
  });

  it("mockReply later turnIndex differs from turnIndex 0 (variants cycle)", () => {
    const first = mockReply("social chatty farmer", "Alice", "hi", 0);
    const second = mockReply("social chatty farmer", "Alice", "hi", 1);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback — live router error → mock-filled turns
// ---------------------------------------------------------------------------

describe("multi-turn — graceful live fallback", () => {
  it("a router that returns {error} yields mock-filled turns and does not throw", async () => {
    const erroringRouter: Router = async (): Promise<LlmResponse> => ({
      raw: "",
      model: "test",
      latencyMs: 1,
      error: "rate_limit_error",
    });
    const { cog, events } = makeCognition({ live: true, router: erroringRouter });
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "social chatty neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    expect(() => cog.onTalk(alice, bob, "Live but offline!")).not.toThrow();
    await SETTLE();

    const turns = convTurns(events);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // Turn 1 falls back to the deterministic mock (social warm greeting).
    expect(turns[1].speaker).toBe("Bob");
    expect(turns[1].text).toContain("Alice");
  });
});

// ---------------------------------------------------------------------------
// Earshot guard — checked once at the start
// ---------------------------------------------------------------------------

describe("multi-turn — earshot guard", () => {
  it("no conversation event when the pair is more than 1 tile apart", async () => {
    const { cog, events } = makeCognition();
    const alice = makeAgent("Alice", "a quiet farmer", { x: 5, y: 5 });
    // Chebyshev distance 2 (out of earshot).
    const bob = makeAgent("Bob", "social chatty neighbor", { x: 7, y: 5 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Can you hear me?");
    await SETTLE();

    expect(events.filter((e) => e.kind === "conversation")).toHaveLength(0);
    // And no reply memory was written either.
    expect(cog.memory.all("Bob").filter((m) => m.text.startsWith("I told Alice:"))).toHaveLength(0);
  });
});
