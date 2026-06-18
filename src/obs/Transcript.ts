/**
 * Transcript — pure model for the HUD conversation panel.
 *
 * Turns a "conversation" WorldEvent (emitted by ConversationSystem) into a
 * render-ready Conversation, then into a clipped, capped TranscriptView for the
 * UIScene chrome. Reads the full payload.turns[] when present and falls back to
 * the legacy say/reply two-liner otherwise.
 *
 * Pure + defensive: no Phaser, never throws. Malformed / non-conversation
 * events return null (conversationFromEvent) or an empty view (buildTranscript).
 */
import type {
  Conversation,
  ConversationTurn,
  Phase,
  WorldEvent,
} from "@contracts/types";

const VALID_PHASES: ReadonlySet<string> = new Set([
  "morning",
  "afternoon",
  "evening",
  "night",
]);

/** A single rendered transcript line. */
export interface TranscriptLine {
  speaker: string;
  text: string;
}

/** Render-ready transcript: participants + capped/clipped lines. */
export interface TranscriptView {
  participants: [string, string];
  lines: TranscriptLine[];
  empty: boolean;
}

/**
 * Parse a "conversation" WorldEvent into a Conversation, or null when the event
 * is not a conversation or is too malformed to recover. Prefers payload.turns;
 * falls back to the legacy say/reply pair. Never throws.
 */
export function conversationFromEvent(e: WorldEvent | null | undefined): Conversation | null {
  try {
    if (!e || e.kind !== "conversation") return null;
    const p = (e.payload ?? {}) as Record<string, unknown>;

    const speaker = typeof p.speaker === "string" ? p.speaker : undefined;
    const listener = typeof p.listener === "string" ? p.listener : undefined;
    if (!speaker || !listener) return null;

    // 1. Preferred: full alternating transcript.
    let turns: ConversationTurn[] = [];
    if (Array.isArray(p.turns)) {
      for (const raw of p.turns) {
        if (!raw || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.speaker === "string" && typeof t.text === "string") {
          turns.push({ speaker: t.speaker, text: t.text });
        }
      }
    }

    // 2. Fallback: legacy say/reply two-liner.
    if (turns.length === 0) {
      const say = typeof p.say === "string" ? p.say : undefined;
      const reply = typeof p.reply === "string" ? p.reply : undefined;
      if (say) turns.push({ speaker, text: say });
      if (reply) turns.push({ speaker: listener, text: reply });
    }

    if (turns.length === 0) return null;

    const id =
      typeof p.conversationId === "string"
        ? p.conversationId
        : `${speaker}|${listener}|${e.day}|${e.phase}`;
    const phase: Phase = VALID_PHASES.has(e.phase) ? e.phase : "morning";

    return {
      id,
      participants: [speaker, listener],
      turns,
      day: typeof e.day === "number" ? e.day : 0,
      phase,
    };
  } catch {
    return null;
  }
}

/**
 * Project a Conversation to a capped/clipped view for the panel. Keeps the most
 * recent `maxLines` turns (oldest-first within the window) and clips each line's
 * text to `maxChars`. Null / empty conversations yield an empty view. Never
 * throws.
 */
export function buildTranscript(
  conv: Conversation | null | undefined,
  maxLines = 6,
  maxChars = 60,
): TranscriptView {
  const fallbackParticipants: [string, string] = ["", ""];
  try {
    if (!conv || !Array.isArray(conv.turns) || conv.turns.length === 0) {
      return {
        participants: conv?.participants ?? fallbackParticipants,
        lines: [],
        empty: true,
      };
    }
    const limit = Math.max(0, Math.floor(maxLines));
    const windowed = limit > 0 ? conv.turns.slice(-limit) : [];
    const lines: TranscriptLine[] = windowed.map((t) => ({
      speaker: t.speaker,
      text: clip(t.text, maxChars),
    }));
    return {
      participants: conv.participants ?? fallbackParticipants,
      lines,
      empty: lines.length === 0,
    };
  } catch {
    return { participants: fallbackParticipants, lines: [], empty: true };
  }
}

function clip(text: string, maxChars: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ");
  const max = Math.max(1, Math.floor(maxChars));
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
