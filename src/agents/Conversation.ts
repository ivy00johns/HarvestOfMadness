/**
 * ConversationSystem — v3 agent-to-agent back-and-forth (Smallville-style).
 *
 * On a resolved TALK_TO (A→B, say S):
 *  1. Generate B's short reply (mock: persona-flavored template; live: one
 *     async LLM call via the live router, falls back to mock on failure).
 *  2. Write memories on both sides (B "said" the reply; A "heard" the reply).
 *  3. Schedule a delayed showSpeech for B (~1.3s after A's bubble) so the
 *     spectator reads A then B, Smallville-style.
 *  4. Emit a "conversation" WorldEvent capturing both lines.
 *
 * Hard rules honored:
 *  - Rule 1: never throws into the caller.
 *  - Rule 10: async work is fire-and-forget; never blocks A's decision loop.
 *  - All side-effects are defensive; reply-generation failure silently falls
 *    back to the mock template.
 *
 * The ConversationSystem is wired into CognitionSystem.onTalk(). It does NOT
 * duplicate affinity recording — onTalk already calls recordInteraction for
 * both sides.
 */
import type { EventBus, GameStamp, Router } from "@contracts/types";
import { getRenderApi } from "../world/render";
import type { Agent } from "./Agent";

// How long (ms) to wait before showing B's reply bubble after A's opener.
const REPLY_BUBBLE_DELAY_MS = 1300;

// ---------------------------------------------------------------------------
// Pure mock-reply helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Deterministic persona-flavored reply template.
 * Keyed off B's persona description keywords. Instant, $0, no I/O.
 */
export function mockReply(bPersona: string, aName: string, _say: string): string {
  const p = bPersona.toLowerCase();

  // Social / chatty — warm and enthusiastic
  if (p.includes("social") || p.includes("chatty") || p.includes("warm")) {
    return `Always good to see you, ${aName}!`;
  }

  // Grumbling / gruff / stern — curt
  if (p.includes("grumbling") || p.includes("gruff") || p.includes("stern") || p.includes("salty")) {
    return `Hmph. If you say so.`;
  }

  // Frugal / thrifty — mentions value
  if (p.includes("frugal") || p.includes("thrift") || p.includes("bargain")) {
    return `Mind the costs, ${aName}. Every copper counts.`;
  }

  // Reckless / impulsive / breezy
  if (p.includes("reckless") || p.includes("impulsive") || p.includes("wild")) {
    return `Ha! Sure thing, let's do it!`;
  }

  // Dreamy / moonstruck / whimsical
  if (p.includes("dreamy") || p.includes("moonstruck") || p.includes("wander") || p.includes("stargazer")) {
    return `The fields hold many stories… I hear you, ${aName}.`;
  }

  // Nervous / meticulous
  if (p.includes("nervous") || p.includes("meticulous") || p.includes("fretful")) {
    return `Oh — yes, of course, ${aName}! I'll keep that in mind.`;
  }

  // Default — neutral acknowledgement
  return `Good to hear, ${aName}.`;
}

// ---------------------------------------------------------------------------
// Live-mode prompt
// ---------------------------------------------------------------------------

function buildReplyPrompt(
  bPersona: string,
  bName: string,
  aName: string,
  affinitySummary: string,
  say: string,
): { system: string; user: string } {
  const system = `You are ${bName}, a farmer. Your persona: ${bPersona}

Reply to what ${aName} just said to you in ONE short sentence (≤ 15 words), in character. No action tags, no quotes around your reply, just the spoken sentence.`;

  const user = `${aName} says to you: "${say}"${
    affinitySummary ? `\nYour relationship with ${aName}: ${affinitySummary}` : ""
  }\n\nYour one-sentence reply (plain text, no quotes):`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// ConversationSystem
// ---------------------------------------------------------------------------

export interface ConversationOpts {
  bus: EventBus;
  now: () => GameStamp;
  live: () => boolean;
  router: Router;
  /** Called to look up B's relationship summary toward A (optional). */
  affinityText?: (bName: string, aName: string) => string;
  /** Memory write helper (fire-and-forget). */
  writeMemory: (agentName: string, text: string, importance: number) => void;
}

export class ConversationSystem {
  private readonly bus: ConversationOpts["bus"];
  private readonly now: ConversationOpts["now"];
  private readonly live: ConversationOpts["live"];
  private readonly router: ConversationOpts["router"];
  private readonly affinityText: NonNullable<ConversationOpts["affinityText"]>;
  private readonly writeMemory: ConversationOpts["writeMemory"];

  constructor(opts: ConversationOpts) {
    this.bus = opts.bus;
    this.now = opts.now;
    this.live = opts.live;
    this.router = opts.router;
    this.affinityText = opts.affinityText ?? (() => "");
    this.writeMemory = opts.writeMemory;
  }

  /**
   * Called from CognitionSystem.onTalk after the existing affinity/diffusion
   * logic. Generates B's reply and handles the display + memory + feed.
   * Fire-and-forget: never blocks, never throws into the caller.
   */
  handleReply(speaker: Agent, listener: Agent, say: string): void {
    // Trim whitespace; treat blank says as missing
    const trimmed = say.trim();
    if (!trimmed) return;

    void this._generate(speaker, listener, trimmed).catch(() => {});
  }

  private async _generate(
    speaker: Agent,
    listener: Agent,
    say: string,
  ): Promise<void> {
    try {
      let reply: string;

      if (this.live()) {
        reply = await this._liveReply(speaker, listener, say);
      } else {
        reply = mockReply(listener.persona.description, speaker.name, say);
      }

      // Sanitize: strip leading/trailing quotes, truncate to 120 chars.
      reply = reply.replace(/^["']+|["']+$/g, "").trim().slice(0, 120);
      if (!reply) {
        reply = mockReply(listener.persona.description, speaker.name, say);
      }

      this._commit(speaker, listener, say, reply);
    } catch {
      // Defensive: fall back to mock on ANY error.
      try {
        const fallback = mockReply(listener.persona.description, speaker.name, say);
        this._commit(speaker, listener, say, fallback);
      } catch {
        /* absolute last resort: silently swallow */
      }
    }
  }

  private async _liveReply(
    speaker: Agent,
    listener: Agent,
    say: string,
  ): Promise<string> {
    try {
      const affinity = this.affinityText(listener.name, speaker.name);
      const { system, user } = buildReplyPrompt(
        listener.persona.description,
        listener.name,
        speaker.name,
        affinity,
        say,
      );

      const res = await this.router({
        agentId: listener.name,
        system,
        user,
        tier: "fast",
      });

      if (res.error || !res.raw?.trim()) {
        return mockReply(listener.persona.description, speaker.name, say);
      }

      // The response is plain text (not JSON), take the first non-empty line.
      const firstLine = res.raw.trim().split("\n")[0]?.trim() ?? "";
      return firstLine || mockReply(listener.persona.description, speaker.name, say);
    } catch {
      return mockReply(listener.persona.description, speaker.name, say);
    }
  }

  private _commit(
    speaker: Agent,
    listener: Agent,
    say: string,
    reply: string,
  ): void {
    const t = this.now();
    const aName = speaker.name;
    const bName = listener.name;

    // 1. Memory: B "said" the reply; A heard B's reply.
    try {
      this.writeMemory(bName, `I told ${aName}: "${reply}"`, 5);
      this.writeMemory(aName, `${bName} replied: "${reply}"`, 5);
    } catch {/* defensive */}

    // 2. Delayed bubble: show B's reply bubble ~REPLY_BUBBLE_DELAY_MS after A's.
    try {
      setTimeout(() => {
        try {
          getRenderApi()?.showSpeech(bName, reply);
        } catch {/* no-op: render may be gone */}
      }, REPLY_BUBBLE_DELAY_MS);
    } catch {/* defensive */}

    // 3. Feed event: "conversation" kind with both lines.
    try {
      this.bus.emit({
        day: t.day,
        phase: t.phase,
        kind: "conversation",
        agentName: aName,
        text: `${aName}: "${say}"  —  ${bName}: "${reply}"`,
        payload: {
          speaker: aName,
          listener: bName,
          say,
          reply,
        },
      });
    } catch {/* defensive */}
  }
}
