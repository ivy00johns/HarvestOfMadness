/**
 * Phase C · Slice (Conversations #2): Conversation-summary memory.
 *
 * After a conversation, each participant writes ONE one-line SUMMARY of what was
 * discussed (Smallville `summarize_conversation`) — a richer focal memory than
 * the legacy quoted-reply line. The summary is:
 *  - DETERMINISTIC: a pure function of (selfName, otherName, turns). No RNG/Date.
 *  - GOSSIP-INERT: written at SUMMARY_IMPORTANCE = 4, BELOW the gossip first-hand
 *    candidate gate (the gossip first-hand gate `importance < 5`) — so it can never become a
 *    gossip candidate and the frozen gossip tests stay green UNCHANGED.
 *  - PER-CONVERSATION (2 total, one per participant) — NOT per-turn. Empty (skipped)
 *    when there is no substantive reply.
 *  - SAFE for the foundation diffusion-dedup `startsWith` filters: it begins with
 *    "Chatted with …", never "X told me about" / "X said:".
 */
import { describe, expect, it } from "vitest";
import type {
  ConversationTurn,
  EventBus,
  GameStamp,
  MemoryEntry,
  Vec2,
  WorldEvent,
} from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import {
  ConversationSystem,
  SUMMARY_IMPORTANCE,
  summarizeConversation,
} from "../../src/agents/Conversation";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Harness (local — mirrors conversation-topics.test.ts)
// ---------------------------------------------------------------------------

function makeStampBus(): { bus: EventBus; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  let seq = 0;
  const bus: EventBus = {
    emit: (e) => {
      events.push({ ...e, seq: ++seq, ts: 0 });
    },
    on: () => () => {},
    recent: () => events,
  };
  return { bus, events };
}

function makeAgent(name: string, persona: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  return new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: persona,
    color: 0xffffff,
    start: pos,
  });
}

const NOW: () => GameStamp = () => ({ day: 1, phase: "morning" });
const SETTLE = () => new Promise((r) => setTimeout(r, 50));

function makeConv(): {
  conv: ConversationSystem;
  events: WorldEvent[];
  writes: { agentName: string; text: string; importance: number }[];
} {
  const { bus, events } = makeStampBus();
  const writes: { agentName: string; text: string; importance: number }[] = [];
  const conv = new ConversationSystem({
    bus,
    now: NOW,
    live: () => false,
    router: async () => ({ raw: "", error: "mock", model: "mock", latencyMs: 0 }),
    writeMemory: (agentName, text, importance) => {
      writes.push({ agentName, text, importance });
    },
  });
  return { conv, events, writes };
}

// ---------------------------------------------------------------------------
// 1. summarizeConversation — pure, deterministic, gossip-safe
// ---------------------------------------------------------------------------

describe("summarizeConversation — pure deterministic summary", () => {
  const turns: ConversationTurn[] = [
    { speaker: "Alice", text: "Morning, Bob!" },
    { speaker: "Bob", text: "The harvest came in early this year, Alice." },
    { speaker: "Alice", text: "Wonderful news indeed." },
  ];

  it("is deterministic — same inputs produce the byte-identical string", () => {
    const a = summarizeConversation("Alice", "Bob", turns);
    const b = summarizeConversation("Alice", "Bob", turns);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("mentions the OTHER agent and references the discussed gist", () => {
    const s = summarizeConversation("Alice", "Bob", turns);
    expect(s).toContain("Bob");
    // the gist is drawn from the substantive (non-opener) turn content
    expect(s.toLowerCase()).toContain("harvest");
  });

  it("starts with 'Chatted with' — never a diffusion-dedup preamble", () => {
    const s = summarizeConversation("Alice", "Bob", turns);
    expect(s.startsWith("Chatted with")).toBe(true);
    expect(s.startsWith("Alice told me about")).toBe(false);
    expect(s.startsWith("Bob told me about")).toBe(false);
    expect(s.startsWith("Bob said:")).toBe(false);
    expect(s.startsWith("Alice said:")).toBe(false);
  });

  it("strips a trailing direct-address so no addressee name dangles in the gist", () => {
    // The substantive reply "The harvest came in early this year, Alice." ends by
    // addressing Alice; neither participant's private summary should keep that
    // dangling ", Alice".
    expect(summarizeConversation("Alice", "Bob", turns)).toBe(
      "Chatted with Bob about The harvest came in early this year",
    );
    expect(summarizeConversation("Bob", "Alice", turns)).toBe(
      "Chatted with Alice about The harvest came in early this year",
    );
  });

  it("is POV-relative — each participant's summary names the OTHER", () => {
    const aSum = summarizeConversation("Alice", "Bob", turns);
    const bSum = summarizeConversation("Bob", "Alice", turns);
    expect(aSum).toContain("Bob");
    expect(bSum).toContain("Alice");
    expect(aSum).not.toBe(bSum);
  });

  it("returns '' when there is no reply (opener only) — caller skips the write", () => {
    const openerOnly: ConversationTurn[] = [{ speaker: "Alice", text: "Morning!" }];
    expect(summarizeConversation("Alice", "Bob", openerOnly)).toBe("");
    expect(summarizeConversation("Alice", "Bob", [])).toBe("");
  });

  it("uses no RNG and no Date — live function source has zero Math.random / Date", () => {
    // Belt-and-braces purity check: scan the live function source for time/RNG.
    const src = summarizeConversation.toString();
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/\bDate\b/);
  });

  it("SUMMARY_IMPORTANCE is 4 — strictly below the gossip first-hand gate (>=5)", () => {
    expect(SUMMARY_IMPORTANCE).toBe(4);
    expect(SUMMARY_IMPORTANCE).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// 2. Integration (mock) — each participant writes ONE summary memory at imp 4
// ---------------------------------------------------------------------------

describe("conversation-summary integration — per-participant summary memory", () => {
  it("each side gets exactly ONE summary at importance 4 mentioning the other", async () => {
    resetWorldForTests();
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    const { conv, writes } = makeConv();
    conv.handleReply(alice, bob, "Morning, Bob!");
    await SETTLE();

    const summaries = writes.filter((w) => w.text.startsWith("Chatted with"));
    // exactly 2: one per participant — NOT per turn.
    expect(summaries).toHaveLength(2);
    // every summary is at the gossip-inert importance.
    expect(summaries.every((w) => w.importance === SUMMARY_IMPORTANCE)).toBe(true);
    expect(summaries.every((w) => w.importance < 5)).toBe(true);

    const aliceSum = summaries.find((w) => w.agentName === "Alice");
    const bobSum = summaries.find((w) => w.agentName === "Bob");
    expect(aliceSum).toBeDefined();
    expect(bobSum).toBeDefined();
    // POV-relative: Alice's summary names Bob, Bob's names Alice.
    expect(aliceSum!.text).toContain("Bob");
    expect(bobSum!.text).toContain("Alice");
  });

  it("the run is replay-identical — two runs write byte-identical summaries", async () => {
    const run = async () => {
      resetWorldForTests();
      const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
      const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
      const { conv, writes } = makeConv();
      conv.handleReply(alice, bob, "Morning, Bob!");
      await SETTLE();
      return writes.filter((w) => w.text.startsWith("Chatted with"));
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it("a no-reply conversation writes NO summary (opener only)", async () => {
    resetWorldForTests();
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    const { conv, writes } = makeConv();
    // A blank say never produces a reply → handleReply short-circuits, no commit.
    conv.handleReply(alice, bob, "   ");
    await SETTLE();
    expect(writes.filter((w) => w.text.startsWith("Chatted with"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Gossip-inert proof — summaries are NEVER gossip candidates
// ---------------------------------------------------------------------------

describe("conversation-summary is gossip-inert", () => {
  it("every summary write is below the gossip first-hand gate (importance < 5)", async () => {
    resetWorldForTests();
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "social chatty neighbor", { x: 5, y: 6 });
    const { conv, writes } = makeConv();
    conv.handleReply(alice, bob, "Morning, Bob!");
    await SETTLE();

    const summaries = writes.filter((w) => w.text.startsWith("Chatted with"));
    expect(summaries.length).toBeGreaterThan(0);
    // The the gossip first-hand gate first-hand candidate gate is `importance < 5 ⇒ continue`
    // (i.e. only importance >= 5 observations are gossip candidates). At
    // importance 4, a summary is structurally excluded — it can never be relayed.
    for (const s of summaries) {
      expect(s.importance).toBeLessThan(5);
    }
  });

  it("the gossip-candidate gate would reject a summary memory at importance 4", () => {
    // Mirror the structural gate from Cognition.onTalk over a synthetic summary
    // memory: type observation, origin undefined (first-hand), importance 4.
    const at: GameStamp = { day: 1, phase: "morning" };
    const summaryMem: MemoryEntry = {
      id: "Alice-sum1",
      agentName: "Alice",
      type: "observation",
      text: summarizeConversation("Alice", "Bob", [
        { speaker: "Alice", text: "Hi" },
        { speaker: "Bob", text: "The well ran dry, Alice." },
      ]),
      importance: SUMMARY_IMPORTANCE,
      createdAt: at,
      lastAccess: at,
    };
    const isFirstHandGossipCandidate =
      summaryMem.type === "observation" &&
      summaryMem.origin === undefined &&
      summaryMem.importance >= 5;
    expect(isFirstHandGossipCandidate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. REAL CognitionSystem boundary — the write-pinning callback keeps imp 4
// ---------------------------------------------------------------------------

describe("conversation-summary through the REAL CognitionSystem", () => {
  it("the summary lands at importance 4 (pinned, NOT re-rated to 5) — gossip-inert end to end", async () => {
    // The unit tests above use a local writeMemory spy; this drives the ACTUAL
    // CognitionSystem write-pinning callback. "Chatted with …" contains "chat",
    // which rateImportanceMock bumps to 5 — so WITHOUT the importance pin the
    // summary would land at 5 and become a gossip candidate. This crosses the
    // real boundary and asserts the pin holds (4 < the gossip first-hand gate).
    resetWorldForTests();
    const { bus } = makeStampBus();
    const cog = new CognitionSystem({ bus, live: () => false, now: NOW });
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    cog.registerAgent(alice);
    cog.registerAgent(bob);

    cog.onTalk(alice, bob, "Morning, Bob!");
    await SETTLE();

    const bobSummaries = cog.memory
      .all("Bob")
      .filter((m) => m.text.startsWith("Chatted with"));
    expect(bobSummaries).toHaveLength(1);
    expect(bobSummaries[0].importance).toBe(4);
    expect(bobSummaries[0].importance).toBeLessThan(5);
    // origin undefined (first-hand) + imp 4 ⇒ excluded from the gossip gate.
    expect(bobSummaries[0].origin).toBeUndefined();
  });
});
