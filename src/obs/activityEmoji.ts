/**
 * Pure activity-emoji map for the Smallville "pronunciatio" overlay.
 * Returns a single emoji representing an agent's current ActionType.
 * No Phaser dependency — unit-testable headless.
 */
import type { ActionType, Emotion } from "@contracts/types";

/**
 * Map an ActionType (and optional emotion for EMOTE) to a single emoji.
 * Every ActionType must return a non-empty string.
 */
export function activityEmoji(action: ActionType, emotion?: Emotion): string {
  switch (action) {
    case "TILL":       return "🪓";
    case "PLANT":      return "🌱";
    case "WATER":      return "💧";
    case "HARVEST":    return "🌾";
    case "BUY":        return "🛒";
    case "SELL":       return "💰";
    case "TALK_TO":    return "💬";
    case "GIVE_GIFT":  return "🎁";
    case "EMOTE":      return emoteEmoji(emotion ?? "neutral");
    case "SLEEP":      return "😴";
    case "MOVE_TO":    return "🚶";
    case "WAIT":       return "💭";
    case "USE_OBJECT": return "✨";
  }
}

function emoteEmoji(emotion: Emotion): string {
  switch (emotion) {
    case "happy":    return "😊";
    case "sad":      return "😢";
    case "annoyed":  return "😠";
    case "excited":  return "🤩";
    case "neutral":  return "😐";
  }
}
