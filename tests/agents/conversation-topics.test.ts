/**
 * Conversation topics — Phase C · Slice 2 (Conversations #1).
 *
 * Conversations become ABOUT what an agent knows/heard about the other
 * (Smallville new_retrieve(focal=other) → summarize_ideas → utterance), which
 * makes the already-green gossip substrate AUDIBLE: a heard rumor is a high-
 * importance focal memory, so it surfaces as a conversation topic.
 *
 * Coverage:
 *  - mockTopicalReply purity: deterministic, references the supplied ideas,
 *    empty ideas → byte-identical to mockReply, zero RNG/Date.
 *  - focal grounding (integration, mock mode): a seeded relayed RUMOR about the
 *    other agent surfaces in a reply turn AND the run is replay-identical.
 *  - additive default: with NO recall dep, turns[] are byte-identical to the
 *    pre-slice mock output.
 *  - buildReplyPrompt gating: absent/empty ideas → byte-identical {system,user};
 *    present ideas → the section appears exactly once.
 *  - feed legibility: formatFeedItem on a conversation event renders a readable
 *    multi-turn line (not the legacy two-liner).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  EventBus,
  GameStamp,
  MemoryEntry,
  Vec2,
  WorldEvent,
} from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import {
  ConversationSystem,
  MAX_TURNS,
  mockReply,
  mockTopicalReply,
  renderIdeas,
} from "../../src/agents/Conversation";
import { buildReplyPrompt } from "../../src/llm/prompts";
import { formatFeedItem } from "../../src/obs/Feed";
import { resetWorldForTests } from "../../src/world/instance";

// ---------------------------------------------------------------------------
// Harness
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

function mem(agentName: string, text: string, importance: number): MemoryEntry {
  const at: GameStamp = { day: 1, phase: "morning" };
  return {
    id: `${agentName}-m0`,
    agentName,
    type: "observation",
    text,
    importance,
    createdAt: at,
    lastAccess: at,
  };
}

/**
 * Build a ConversationSystem in mock mode, optionally with a recall dep. The
 * spy captures every (agentName, text, importance) written so we can assert the
 * one-pair memory invariant is untouched.
 */
function makeConv(opts?: {
  recall?: (agentName: string, query: string) => Promise<MemoryEntry[]>;
}): {
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
    ...(opts?.recall ? { recall: opts.recall } : {}),
  });
  return { conv, events, writes };
}

const SETTLE = () => new Promise((r) => setTimeout(r, 50));

function convTurns(events: WorldEvent[]): { speaker: string; text: string }[] {
  const e = events.find((x) => x.kind === "conversation");
  return (e?.payload?.turns as { speaker: string; text: string }[]) ?? [];
}

beforeEach(() => {
  resetWorldForTests();
});

// ---------------------------------------------------------------------------
// 1. mockTopicalReply — purity, references ideas, empty == mockReply
// ---------------------------------------------------------------------------

describe("mockTopicalReply — pure topical template", () => {
  it("is deterministic: same inputs → same string, repeated", () => {
    const a = mockTopicalReply("grumbling gruff farmer", "Alice", "the mill burned down", 1);
    const b = mockTopicalReply("grumbling gruff farmer", "Alice", "the mill burned down", 1);
    const c = mockTopicalReply("grumbling gruff farmer", "Alice", "the mill burned down", 1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("references the supplied ideas gist", () => {
    const reply = mockTopicalReply("social chatty farmer", "Bob", "the harvest failed", 0);
    expect(reply).toContain("the harvest failed");
    expect(reply).toContain("Bob");
  });

  it("empty ideas → BYTE-IDENTICAL to mockReply (all turnIndexes, several personas)", () => {
    const personas = [
      "social chatty farmer",
      "grumbling gruff neighbor",
      "frugal thrifty merchant",
      "reckless wild ranger",
      "dreamy moonstruck poet",
      "nervous meticulous clerk",
      "a quiet plain farmer",
    ];
    for (const persona of personas) {
      for (let t = 0; t < 6; t++) {
        expect(mockTopicalReply(persona, "Alice", "", t)).toBe(
          mockReply(persona, "Alice", "", t),
        );
        // blank/whitespace-only ideas degrade identically
        expect(mockTopicalReply(persona, "Alice", "   ", t)).toBe(
          mockReply(persona, "Alice", "", t),
        );
      }
    }
  });

  it("variant cycles by turnIndex (non-empty ideas)", () => {
    const v0 = mockTopicalReply("grumbling gruff farmer", "Alice", "x", 0);
    const v1 = mockTopicalReply("grumbling gruff farmer", "Alice", "x", 1);
    const v3 = mockTopicalReply("grumbling gruff farmer", "Alice", "x", 3);
    expect(v0).not.toBe(v1);
    expect(v3).toBe(v0); // 3 variants → index 3 wraps to 0
  });

  it("contains zero RNG/Date markers in the source", () => {
    // Guard at the unit level: re-evaluating with frozen time yields the same
    // string (it never reads Date/Math.random).
    const real = Math.random;
    const reof = Date.now;
    Math.random = () => {
      throw new Error("RNG must not be called");
    };
    Date.now = () => {
      throw new Error("Date must not be called");
    };
    try {
      const r = mockTopicalReply("social chatty farmer", "Bob", "the well ran dry", 2);
      expect(r).toBeTruthy();
    } finally {
      Math.random = real;
      Date.now = reof;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. renderIdeas — deterministic gist from retrieved memories
// ---------------------------------------------------------------------------

describe("renderIdeas — deterministic ideas gist", () => {
  it("returns '' for no memories", () => {
    expect(renderIdeas([])).toBe("");
  });

  it("picks the highest-importance memory and strips the 'I heard that' preamble", () => {
    const gist = renderIdeas([
      { text: "I saw the cows escape", importance: 3 },
      { text: "I heard that Mara hid the seed grain", importance: 8 },
    ]);
    expect(gist).toBe("Mara hid the seed grain");
  });

  it("strips a bare leading 'I ' when there is no hearsay verb", () => {
    const gist = renderIdeas([{ text: "I saw Tom by the river", importance: 5 }]);
    expect(gist).toBe("saw Tom by the river");
  });

  it("strips surrounding quotes after dropping leading 'I '", () => {
    const gist = renderIdeas([{ text: '"the well ran dry"', importance: 5 }]);
    expect(gist).toBe("the well ran dry");
  });

  it("strips third-person hearsay preambles (no doubled hearsay in topical replies)", () => {
    // Event/governance diffusion + recordSpeech use third-person preambles; a
    // two-word agent name must still strip cleanly to the bare claim.
    expect(renderIdeas([{ text: "Diligent Dora told me about the gathering at the tavern", importance: 7 }]))
      .toBe("the gathering at the tavern");
    expect(renderIdeas([{ text: "Grumbling Gus said: the prices are rising", importance: 6 }]))
      .toBe("the prices are rising");
    expect(renderIdeas([{ text: 'Frugal Fern replied: "every copper counts"', importance: 5 }]))
      .toBe("every copper counts");
    expect(renderIdeas([{ text: "Salty Ford mentioned (heard from Nell): the bridge is out", importance: 5 }]))
      .toBe("the bridge is out");
    // A bare claim with no preamble is untouched (no over-strip).
    expect(renderIdeas([{ text: "Alice lost the deed to the north field", importance: 6 }]))
      .toBe("Alice lost the deed to the north field");
  });
});

// ---------------------------------------------------------------------------
// 3. Focal grounding — a heard RUMOR becomes an audible conversation topic
// ---------------------------------------------------------------------------

describe("focal grounding (mock) — a heard rumor surfaces as a topic", () => {
  it("a seeded relayed rumor about the other agent surfaces in a reply turn", async () => {
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    // Grumbling B never closes early → runs to the cap, so B gets a reply turn.
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });

    // Bob has HEARD a rumor about Alice (a relayed gossip memory, importance ≥ 5).
    const RUMOR = "Alice lost the deed to the north field";
    const recall = async (agentName: string, query: string): Promise<MemoryEntry[]> => {
      if (agentName === "Bob" && query === "Alice") {
        return [mem("Bob", `I heard that ${RUMOR}`, 6)];
      }
      return [];
    };

    const { conv, events } = makeConv({ recall });
    conv.handleReply(alice, bob, "Morning, Bob!");
    await SETTLE();

    const turns = convTurns(events);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // Bob's reply (turn 1) must reference the rumor gist → gossip is audible.
    const bobReply = turns[1].text;
    expect(bobReply).toContain(RUMOR);
  });

  it("the grounded run is replay-identical", async () => {
    const RUMOR = "the bridge washed out last night";
    const recall = async (agentName: string, query: string): Promise<MemoryEntry[]> => {
      if (agentName === "Bob" && query === "Alice") {
        return [mem("Bob", `I heard ${RUMOR}`, 7)];
      }
      return [];
    };

    const run = async (): Promise<{ speaker: string; text: string }[]> => {
      resetWorldForTests();
      const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
      const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
      const { conv, events } = makeConv({ recall });
      conv.handleReply(alice, bob, "Morning, Bob!");
      await SETTLE();
      return convTurns(events);
    };

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });

  it("grounding does NOT add memories — still exactly ONE legacy pair", async () => {
    const recall = async (agentName: string, query: string): Promise<MemoryEntry[]> => {
      if (agentName === "Bob" && query === "Alice") {
        return [mem("Bob", "I heard Alice sold her ox", 6)];
      }
      return [];
    };
    const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
    const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
    const { conv, writes } = makeConv({ recall });
    conv.handleReply(alice, bob, "Morning!");
    await SETTLE();

    // Per CONVERSATION (NOT per turn): exactly 4 writes — the ONE legacy pair
    // (Bob "told", Alice "heard") PLUS the 2 conversation summaries (one per
    // participant). No per-turn spam: the exchange ran multiple turns but the
    // memory stream still gains a fixed, bounded set.
    const legacy = writes.filter(
      (w) => w.text.startsWith("I told ") || w.text.includes(" replied: "),
    );
    const summaries = writes.filter((w) => w.text.startsWith("Chatted with"));
    // Exactly ONE legacy pair (Bob told + Alice heard) — unchanged invariant.
    expect(legacy).toHaveLength(2);
    expect(legacy[0].agentName).toBe("Bob");
    expect(legacy[1].agentName).toBe("Alice");
    // Exactly 2 summaries (one per participant), gossip-inert at importance 4.
    expect(summaries).toHaveLength(2);
    expect(summaries.every((w) => w.importance === 4)).toBe(true);
    // Nothing else: 2 legacy + 2 summaries, no per-turn extras.
    expect(writes.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 4. Additive default — no recall dep ⇒ byte-identical turns[]
// ---------------------------------------------------------------------------

describe("additive default — no recall dep is byte-identical to pre-slice", () => {
  it("turns[] match the recall-free run exactly", async () => {
    const run = async (withRecall: boolean): Promise<{ speaker: string; text: string }[]> => {
      resetWorldForTests();
      const alice = makeAgent("Alice", "a quiet plain farmer", { x: 5, y: 5 });
      const bob = makeAgent("Bob", "grumbling gruff neighbor", { x: 5, y: 6 });
      // recall present BUT returns nothing → must equal the no-recall path.
      const recall = withRecall ? async () => [] as MemoryEntry[] : undefined;
      const { conv, events } = makeConv(recall ? { recall } : undefined);
      conv.handleReply(alice, bob, "Morning, Bob!");
      await SETTLE();
      return convTurns(events);
    };

    const noRecall = await run(false);
    const emptyRecall = await run(true);
    expect(emptyRecall).toEqual(noRecall);
    // And it is genuinely the generic mock template (no topic woven in).
    expect(noRecall[1].text).toBe(
      mockReply("grumbling gruff neighbor", "Alice", "", 0),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. buildReplyPrompt gating
// ---------------------------------------------------------------------------

describe("buildReplyPrompt — ideas is GATED", () => {
  const base = {
    selfPersona: "a quiet farmer",
    selfName: "Bob",
    otherName: "Alice",
    affinitySummary: "",
    transcriptTail: [{ speaker: "Alice", text: "Morning!" }],
  };

  it("absent ideas ⇒ byte-identical {system,user} to no-ideas", () => {
    const a = buildReplyPrompt(base);
    const b = buildReplyPrompt({ ...base, ideas: undefined });
    const c = buildReplyPrompt({ ...base, ideas: "   " });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("present ideas ⇒ the section appears exactly once", () => {
    const out = buildReplyPrompt({ ...base, ideas: "the harvest failed" });
    const marker = "What's on your mind about Alice";
    expect(out.user.split(marker).length - 1).toBe(1);
    expect(out.user).toContain("the harvest failed");
    // system block is untouched by ideas
    expect(out.system).toBe(buildReplyPrompt(base).system);
  });
});

// ---------------------------------------------------------------------------
// 6. Feed legibility — conversation renders a readable multi-turn line
// ---------------------------------------------------------------------------

describe("formatFeedItem — conversation is legible", () => {
  it("renders A ⇄ B with the turns transcript, not the legacy two-liner", () => {
    const event: WorldEvent = {
      day: 1,
      phase: "morning",
      kind: "conversation",
      agentName: "Alice",
      text: 'Alice: "Morning!"  —  Bob: "Hmph."',
      payload: {
        speaker: "Alice",
        listener: "Bob",
        say: "Morning!",
        reply: "Hmph.",
        turns: [
          { speaker: "Alice", text: "Morning!" },
          { speaker: "Bob", text: "Hmph." },
        ],
        conversationId: "Alice|Bob|1|morning",
      },
      seq: 1,
      ts: 0,
    };
    const view = formatFeedItem({ type: "event", event }, 120);
    expect(view.text).toContain("Alice ⇄ Bob");
    expect(view.text).toContain("Morning!");
    expect(view.text).toContain("Hmph.");
    // NOT the legacy two-liner em-dash join
    expect(view.text).not.toContain('  —  ');
    expect(view.emphasis).toBe(true);
    expect(view.agentName).toBe("Alice");
  });
});

// guard: the cap is unchanged
describe("invariants", () => {
  it("MAX_TURNS still 4", () => {
    expect(MAX_TURNS).toBe(4);
  });
});
