/**
 * Pure unit tests for the activityEmoji map (Smallville "pronunciatio").
 * Every ActionType must return a non-empty string; EMOTE must vary by emotion.
 */
import { describe, expect, it } from "vitest";
import type { ActionType, Emotion } from "@contracts/types";
import { activityEmoji } from "../../src/obs/activityEmoji";

const ALL_ACTIONS: ActionType[] = [
  "TILL",
  "PLANT",
  "WATER",
  "HARVEST",
  "BUY",
  "SELL",
  "TALK_TO",
  "GIVE_GIFT",
  "EMOTE",
  "SLEEP",
  "MOVE_TO",
  "WAIT",
  "USE_OBJECT",
  "VOTE",
];

const ALL_EMOTIONS: Emotion[] = ["neutral", "happy", "annoyed", "sad", "excited"];

describe("activityEmoji", () => {
  it("every ActionType returns a non-empty string", () => {
    for (const action of ALL_ACTIONS) {
      const result = activityEmoji(action);
      expect(result, `activityEmoji("${action}") must be non-empty`).toBeTruthy();
      expect(typeof result).toBe("string");
    }
  });

  it("EMOTE varies by emotion — all emotions return different emojis", () => {
    const results = ALL_EMOTIONS.map((e) => activityEmoji("EMOTE", e));
    const unique = new Set(results);
    expect(unique.size).toBe(ALL_EMOTIONS.length);
  });

  it("EMOTE without emotion defaults to a non-empty string", () => {
    const result = activityEmoji("EMOTE");
    expect(result).toBeTruthy();
  });

  it("non-EMOTE actions ignore the emotion parameter", () => {
    // The same action should return the same emoji regardless of emotion
    for (const action of ALL_ACTIONS.filter((a) => a !== "EMOTE")) {
      const withEmotion = activityEmoji(action, "happy");
      const withoutEmotion = activityEmoji(action);
      expect(withEmotion, `"${action}" should be stable regardless of emotion`).toBe(withoutEmotion);
    }
  });

  it("specific mappings are sensible", () => {
    expect(activityEmoji("SLEEP")).toBe("😴");
    expect(activityEmoji("HARVEST")).toBe("🌾");
    expect(activityEmoji("WATER")).toBe("💧");
    expect(activityEmoji("GIVE_GIFT")).toBe("🎁");
    expect(activityEmoji("VOTE")).toBe("🗳️");
    expect(activityEmoji("EMOTE", "happy")).toBe("😊");
    expect(activityEmoji("EMOTE", "sad")).toBe("😢");
    expect(activityEmoji("EMOTE", "annoyed")).toBe("😠");
    expect(activityEmoji("EMOTE", "excited")).toBe("🤩");
    expect(activityEmoji("EMOTE", "neutral")).toBe("😐");
  });
});
