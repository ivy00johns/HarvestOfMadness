/**
 * Transcript — pure model for the HUD conversation panel.
 *
 * Coverage (spec §5):
 *  - conversationFromEvent: parses payload.turns; falls back to say/reply;
 *    returns null for non-conversation / malformed events; never throws.
 *  - buildTranscript: caps to maxLines (most recent), clips text to maxChars,
 *    flags empty for null / no-turns conversations.
 */
import { describe, expect, it } from "vitest";
import type { Conversation, WorldEvent } from "@contracts/types";
import { buildTranscript, conversationFromEvent } from "../../src/obs/Transcript";

function ev(partial: Partial<WorldEvent>): WorldEvent {
  return {
    seq: 1,
    day: 2,
    phase: "afternoon",
    kind: "conversation",
    text: "",
    ts: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// conversationFromEvent
// ---------------------------------------------------------------------------

describe("conversationFromEvent — parse", () => {
  it("reads the full turns[] transcript from the payload", () => {
    const e = ev({
      day: 3,
      phase: "evening",
      payload: {
        speaker: "Alice",
        listener: "Bob",
        say: "Hi",
        reply: "Hello",
        turns: [
          { speaker: "Alice", text: "Hi" },
          { speaker: "Bob", text: "Hello" },
          { speaker: "Alice", text: "Nice day" },
        ],
        conversationId: "Alice|Bob|3|evening",
      },
    });
    const conv = conversationFromEvent(e);
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe("Alice|Bob|3|evening");
    expect(conv!.participants).toEqual(["Alice", "Bob"]);
    expect(conv!.turns).toHaveLength(3);
    expect(conv!.turns[2]).toEqual({ speaker: "Alice", text: "Nice day" });
    expect(conv!.day).toBe(3);
    expect(conv!.phase).toBe("evening");
  });

  it("falls back to the legacy say/reply pair when turns[] is absent", () => {
    const e = ev({
      payload: { speaker: "Carol", listener: "Dave", say: "Morning", reply: "Hey" },
    });
    const conv = conversationFromEvent(e);
    expect(conv).not.toBeNull();
    expect(conv!.turns).toEqual([
      { speaker: "Carol", text: "Morning" },
      { speaker: "Dave", text: "Hey" },
    ]);
    // Derived id when none was published.
    expect(conv!.id).toBe("Carol|Dave|2|afternoon");
  });

  it("derives an id from day/phase when conversationId is missing", () => {
    const e = ev({
      day: 5,
      phase: "night",
      payload: {
        speaker: "Eve",
        listener: "Finn",
        turns: [{ speaker: "Eve", text: "Yo" }],
      },
    });
    expect(conversationFromEvent(e)!.id).toBe("Eve|Finn|5|night");
  });
});

describe("conversationFromEvent — null / malformed", () => {
  it("returns null for a non-conversation event", () => {
    expect(conversationFromEvent(ev({ kind: "agent_moved" }))).toBeNull();
  });

  it("returns null for null / undefined input", () => {
    expect(conversationFromEvent(null)).toBeNull();
    expect(conversationFromEvent(undefined)).toBeNull();
  });

  it("returns null when participants are missing", () => {
    expect(conversationFromEvent(ev({ payload: { say: "Hi", reply: "Yo" } }))).toBeNull();
  });

  it("returns null when there are no usable turns and no say/reply", () => {
    expect(
      conversationFromEvent(ev({ payload: { speaker: "A", listener: "B" } })),
    ).toBeNull();
  });

  it("skips malformed turn entries but keeps the well-formed ones", () => {
    const e = ev({
      payload: {
        speaker: "A",
        listener: "B",
        turns: [
          { speaker: "A", text: "ok" },
          { speaker: 7, text: "bad" }, // non-string speaker
          null,
          "nope",
          { speaker: "B", text: "good" },
        ],
      },
    });
    const conv = conversationFromEvent(e);
    expect(conv!.turns).toEqual([
      { speaker: "A", text: "ok" },
      { speaker: "B", text: "good" },
    ]);
  });

  it("never throws on hostile payloads", () => {
    expect(() => conversationFromEvent(ev({ payload: undefined }))).not.toThrow();
    expect(() =>
      conversationFromEvent(ev({ payload: { speaker: "A", listener: "B", turns: 42 as never } })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

function conv(turns: { speaker: string; text: string }[]): Conversation {
  return {
    id: "X|Y|1|morning",
    participants: ["X", "Y"],
    turns,
    day: 1,
    phase: "morning",
  };
}

describe("buildTranscript — caps, clips, empty", () => {
  it("keeps the most recent maxLines turns (oldest-first within the window)", () => {
    const c = conv([
      { speaker: "X", text: "1" },
      { speaker: "Y", text: "2" },
      { speaker: "X", text: "3" },
      { speaker: "Y", text: "4" },
    ]);
    const view = buildTranscript(c, 2);
    expect(view.empty).toBe(false);
    expect(view.lines.map((l) => l.text)).toEqual(["3", "4"]);
    expect(view.participants).toEqual(["X", "Y"]);
  });

  it("clips each line's text to maxChars with an ellipsis", () => {
    const long = "x".repeat(100);
    const view = buildTranscript(conv([{ speaker: "X", text: long }]), 6, 10);
    expect(view.lines[0].text).toHaveLength(10);
    expect(view.lines[0].text.endsWith("…")).toBe(true);
  });

  it("does not clip text shorter than maxChars", () => {
    const view = buildTranscript(conv([{ speaker: "X", text: "short" }]), 6, 60);
    expect(view.lines[0].text).toBe("short");
  });

  it("flags empty for a null conversation", () => {
    const view = buildTranscript(null);
    expect(view.empty).toBe(true);
    expect(view.lines).toHaveLength(0);
  });

  it("flags empty for a conversation with no turns", () => {
    const view = buildTranscript(conv([]));
    expect(view.empty).toBe(true);
    expect(view.lines).toHaveLength(0);
  });

  it("never throws on a malformed conversation", () => {
    expect(() => buildTranscript({ turns: null } as never)).not.toThrow();
  });
});
