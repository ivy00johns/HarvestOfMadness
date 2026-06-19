/**
 * ConversationSystem — v3 (Wave 2) multi-turn agent-to-agent back-and-forth
 * (Smallville-style readable dialogue).
 *
 * On a resolved TALK_TO (A→B, opener S):
 *  1. Run a short ALTERNATING exchange (A's opener is turn 0; B replies on turn
 *     1, A on turn 2, …) up to MAX_TURNS total utterances. Each generated reply
 *     comes from the fast-tier live router (mock fallback on error/empty), and
 *     the loop stops early on a closing line (CLOSER_RE) or an empty reply.
 *  2. Write exactly ONE legacy memory pair per conversation (B "told" A the
 *     first reply; A "heard" that reply) — NOT per turn, to keep memory anti-
 *     spam and gossip/diffusion dedup counts unchanged. The full transcript
 *     lives in the bus payload, never in the memory stream.
 *  3. Schedule delayed showSpeech bubbles for every turn ≥ 1, sequentially, so
 *     the spectator reads A then B then A … Smallville-style.
 *  4. Emit a single "conversation" WorldEvent capturing the legacy two-liner
 *     plus the full turns[] transcript and a stable conversationId.
 *
 * Hard rules honored:
 *  - Rule 1: never throws into the caller.
 *  - Rule 10: ALL async work is fire-and-forget; never blocks A's decision loop.
 *  - All side-effects are defensive; reply-generation failure silently falls
 *    back to the deterministic mock template.
 *
 * The ConversationSystem is wired into CognitionSystem.onTalk(). It does NOT
 * touch affinity — onTalk already calls recordInteraction once per side (+2),
 * and the multi-turn exchange must NOT multiply that.
 */
import type {
  ConversationTurn,
  EventBus,
  GameStamp,
  MemoryEntry,
  Router,
} from "@contracts/types";
import { getRenderApi } from "../world/render";
import { buildReplyPrompt } from "../llm/prompts";
import { chebyshev } from "./Observation";
import type { Agent } from "./Agent";

// Total utterances INCLUDING A's opener (turn 0). ≤3 generated replies; ≤2/side.
export const MAX_TURNS = 4;
// Gap between consecutive reply bubbles (turns ≥ 2 stagger after the first).
export const TURN_GAP_MS = 1500;
// How long (ms) to wait before showing B's first reply bubble after A's opener.
export const REPLY_BUBBLE_DELAY_MS = 1300;
// A reply that matches this ends the conversation naturally.
export const CLOSER_RE = /\b(bye|goodbye|see you|farewell|good night|take care|later)\b/i;
// How many trailing transcript lines to feed the live prompt.
const TRANSCRIPT_TAIL = 4;

// ---------------------------------------------------------------------------
// Pure mock-reply helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Deterministic persona-flavored reply template, indexed by turn.
 *
 * Keyed off B's persona description keywords. Instant, $0, no I/O, no RNG/time:
 * the variant is `turnIndex % variants.length`, so two runs are byte-identical.
 *
 * INVARIANT: turnIndex 0 (the default) returns BYTE-IDENTICAL output to the v2
 * single-utterance template (keeps the existing mockReply assertions green).
 * One social variant carries a closer line so a natural conversation can end.
 */
export function mockReply(
  bPersona: string,
  aName: string,
  _prev: string,
  turnIndex = 0,
): string {
  const p = bPersona.toLowerCase();
  const pick = (variants: string[]): string =>
    variants[((turnIndex % variants.length) + variants.length) % variants.length];

  // Social / chatty — warm and enthusiastic. NOTE: the byte-identical v2
  // greeting "Always good to see you" contains "see you", which matches
  // CLOSER_RE — so a social opener-reply naturally ends the exchange early
  // (this is the "one social variant with a closer line" the spec calls for).
  if (p.includes("social") || p.includes("chatty") || p.includes("warm")) {
    return pick([
      `Always good to see you, ${aName}!`,
      `Oh, do tell me more, ${aName}!`,
      `We should chat again soon — take care, ${aName}!`,
    ]);
  }

  // Grumbling / gruff / stern — curt
  if (
    p.includes("grumbling") ||
    p.includes("gruff") ||
    p.includes("stern") ||
    p.includes("salty")
  ) {
    return pick([
      `Hmph. If you say so.`,
      `Fine. Anything else?`,
      `Right. Goodbye then.`,
    ]);
  }

  // Frugal / thrifty — mentions value
  if (p.includes("frugal") || p.includes("thrift") || p.includes("bargain")) {
    return pick([
      `Mind the costs, ${aName}. Every copper counts.`,
      `A fair price is all I ask, ${aName}.`,
      `Well, see you at the market, ${aName}.`,
    ]);
  }

  // Reckless / impulsive / breezy
  if (p.includes("reckless") || p.includes("impulsive") || p.includes("wild")) {
    return pick([
      `Ha! Sure thing, let's do it!`,
      `Why not — count me in!`,
      `Catch you later, ${aName}!`,
    ]);
  }

  // Dreamy / moonstruck / whimsical
  if (
    p.includes("dreamy") ||
    p.includes("moonstruck") ||
    p.includes("wander") ||
    p.includes("stargazer")
  ) {
    return pick([
      `The fields hold many stories… I hear you, ${aName}.`,
      `Such wondrous thoughts, ${aName} — go on.`,
      `Until the stars align again, ${aName}.`,
    ]);
  }

  // Nervous / meticulous
  if (p.includes("nervous") || p.includes("meticulous") || p.includes("fretful")) {
    return pick([
      `Oh — yes, of course, ${aName}! I'll keep that in mind.`,
      `Quite right, ${aName} — I'll be careful.`,
      `Alright then, ${aName} — see you later!`,
    ]);
  }

  // Default — neutral acknowledgement
  return pick([
    `Good to hear, ${aName}.`,
    `Is that so, ${aName}?`,
    `Well, take care, ${aName}.`,
  ]);
}

/**
 * Deterministic persona-flavored reply that WEAVES a recalled-memory `ideas`
 * gist about the other agent into a short utterance — Smallville's
 * `new_retrieve(focal=other) → summarize_ideas → utterance` made audible.
 *
 * Purity: a total function of `(bPersona, aName, ideas, turnIndex)`. No RNG, no
 * Date — the variant is `turnIndex % variants.length`, so two runs are
 * byte-identical. The `ideas` text is inserted verbatim (already a deterministic
 * render of retrieved memory) so callers can assert the topic surfaced.
 *
 * INVARIANT: when `ideas` is empty/blank, returns BYTE-IDENTICAL output to
 * `mockReply(bPersona, aName, "", turnIndex)` — so `_oneTurn` only needs to
 * branch to this helper when there is actually something to talk about, and a
 * caller that always uses it degrades cleanly to the generic template.
 */
export function mockTopicalReply(
  bPersona: string,
  aName: string,
  ideas: string,
  turnIndex = 0,
): string {
  const gist = ideas.trim();
  // Empty ideas ⇒ generic template, byte-identical to mockReply.
  if (!gist) return mockReply(bPersona, aName, "", turnIndex);

  const p = bPersona.toLowerCase();
  const pick = (variants: string[]): string =>
    variants[((turnIndex % variants.length) + variants.length) % variants.length];

  // Social / chatty — warm, leans in on the topic.
  if (p.includes("social") || p.includes("chatty") || p.includes("warm")) {
    return pick([
      `Oh ${aName}, I keep thinking — ${gist}!`,
      `Speaking of which, ${aName} — ${gist}, no?`,
      `We should talk more about ${gist}, ${aName}!`,
    ]);
  }

  // Grumbling / gruff / stern — curt about the topic.
  if (
    p.includes("grumbling") ||
    p.includes("gruff") ||
    p.includes("stern") ||
    p.includes("salty")
  ) {
    return pick([
      `Hmph. Heard ${gist}.`,
      `So it's true then — ${gist}.`,
      `${gist}, eh? Figures.`,
    ]);
  }

  // Frugal / thrifty — ties the topic to value.
  if (p.includes("frugal") || p.includes("thrift") || p.includes("bargain")) {
    return pick([
      `They say ${gist}, ${aName} — costly business.`,
      `${gist}? Worth keeping an eye on, ${aName}.`,
      `A fair word: ${gist}, ${aName}.`,
    ]);
  }

  // Reckless / impulsive / breezy.
  if (p.includes("reckless") || p.includes("impulsive") || p.includes("wild")) {
    return pick([
      `Ha! Word is ${gist}, ${aName}!`,
      `${gist}? Let's chase that, ${aName}!`,
      `Heard ${gist} — wild, ${aName}!`,
    ]);
  }

  // Dreamy / moonstruck / whimsical.
  if (
    p.includes("dreamy") ||
    p.includes("moonstruck") ||
    p.includes("wander") ||
    p.includes("stargazer")
  ) {
    return pick([
      `The fields whisper that ${gist}, ${aName}…`,
      `I dreamt of it — ${gist}, ${aName}.`,
      `Such tidings: ${gist}, ${aName}.`,
    ]);
  }

  // Nervous / meticulous.
  if (p.includes("nervous") || p.includes("meticulous") || p.includes("fretful")) {
    return pick([
      `Oh — I heard ${gist}, ${aName}! Is that right?`,
      `${gist}? Goodness, ${aName}, I'll be careful.`,
      `They told me ${gist}, ${aName} — quite a thing.`,
    ]);
  }

  // Default — neutral, surfaces the topic.
  return pick([
    `I heard ${gist}, ${aName}.`,
    `Is it true that ${gist}, ${aName}?`,
    `Word has it ${gist}, ${aName}.`,
  ]);
}

/**
 * Render a short deterministic "ideas" gist from retrieved memories — what the
 * responder knows/heard about the other agent. Pure: takes the top entries (by
 * the store's own deterministic ranking) and renders the highest-importance
 * line's text, lightly normalized (leading "I "/quotes stripped, clipped). No
 * RNG/Date. Returns "" when there is nothing worth surfacing.
 */
export function renderIdeas(memories: { text: string; importance: number }[]): string {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  // Most poignant first; stable tie-break by text so the render is deterministic.
  const best = [...memories].sort(
    (a, b) => b.importance - a.importance || a.text.localeCompare(b.text),
  )[0];
  if (!best) return "";
  // Normalize a first-person hearsay preamble ("I heard that …", "I told …",
  // "X replied: …") down to the bare claim so the topical templates can frame it
  // without doubling verbs. Pure string ops — no RNG/Date.
  const gist = best.text
    .replace(/^\s*I\s+(?:heard|learned|gathered)\s+(?:that\s+)?/i, "")
    .replace(/^\s*I\s+/i, "")
    // Third-person hearsay preambles — "<name> told me about …", "<name> said: …",
    // "<name> replied: …", "<name> mentioned (heard from …): …" — strip down to the
    // bare claim so a topical reply doesn't double the hearsay verb ("Heard X told
    // me about …"). The bounded `.{0,40}?` prefix admits a two-word agent name
    // without risking a runaway strip. Pure string ops — no RNG/Date.
    .replace(/^.{0,40}?\btold me about\s+/i, "")
    .replace(/^.{0,40}?\b(?:said|replied|mentioned)\b[^:]*:\s*/i, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return gist;
}

// ---------------------------------------------------------------------------
// Conversation-summary memory (Smallville `summarize_conversation`)
// ---------------------------------------------------------------------------

/**
 * Importance for the per-participant conversation summary memory.
 *
 * Pinned to 4 — STRICTLY BELOW the gossip first-hand candidate gate in
 * `Cognition.onTalk` (`if (m.importance < 5) continue;`). The full gate is
 * `type === "observation" && origin === undefined && importance >= 5`, so a
 * summary (a first-hand observation at importance 4) is structurally excluded
 * from the gossip candidate set: it can never be relayed and the frozen
 * gossip.test.ts stays green UNCHANGED. Summaries are richer focal memories for
 * recall + reflection, NOT rumors.
 */
export const SUMMARY_IMPORTANCE = 4;

/**
 * Deterministic one-line conversation summary from `selfName`'s POV — the mock
 * stand-in for Smallville's `summarize_conversation`. Distills the exchange's
 * gist into `Chatted with ${otherName} about ${gist}`.
 *
 * PURITY: a total function of `(selfName, otherName, turns)`. No RNG, no Date —
 * the gist is the longest SUBSTANTIVE (non-opener) turn's text, normalized and
 * clipped via the same deterministic string ops as `renderIdeas`. Two runs are
 * byte-identical.
 *
 * Gist source: the opener (turn 0) is small-talk; the substance lives in the
 * REPLIES (turns ≥ 1). The longest reply is the most informative line; ties
 * break on text (localeCompare) for stability. The preamble is normalized so the
 * summary reads cleanly and — critically — does NOT begin with the foundation
 * slice's diffusion-dedup `startsWith` preambles ("X told me about" / "X said:").
 * It always begins with the safe literal "Chatted with ".
 *
 * Returns "" when there is no substance (no reply / empty turns) so the caller
 * skips the write entirely (mirrors the no-reply → no legacy-pair discipline).
 */
export function summarizeConversation(
  selfName: string,
  otherName: string,
  turns: ConversationTurn[],
): string {
  if (!Array.isArray(turns) || turns.length < 2) return "";
  // Substance = the replies (turns >= 1); the opener is small-talk.
  const replies = turns
    .slice(1)
    .map((t) => (t?.text ?? "").trim())
    .filter((t) => t.length > 0);
  if (replies.length === 0) return "";
  // The longest reply is the most informative; stable tie-break by text so the
  // render is deterministic. Pure — no RNG/Date.
  const best = [...replies].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )[0];
  // Reuse renderIdeas' deterministic normalization (strip hearsay preambles +
  // quotes, collapse whitespace, clip) to derive a clean gist, then drop a
  // trailing direct-address ("…, Alice." / "…, Bob!") naming EITHER participant
  // so a reply that addresses someone doesn't leave that name dangling inside a
  // third party's private summary. Pure string ops — no RNG/Date.
  let gist = renderIdeas([{ text: best, importance: 1 }]);
  for (const name of [selfName, otherName]) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    gist = gist.replace(new RegExp(`[,\\s]+${esc}\\s*[.!?]*\\s*$`, "i"), "");
  }
  gist = gist.trim();
  if (!gist) return "";
  return `Chatted with ${otherName} about ${gist}`;
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
  /**
   * OPTIONAL memory recall — Smallville's `new_retrieve(focal=other)`. When
   * present, the responder's top memories about `query` (the other agent's
   * name) ground the reply in a topic. When ABSENT, conversation output is
   * BYTE-IDENTICAL to today (every existing test omits this). Never trusted to
   * throw: the call-site wraps it and degrades to the generic reply.
   */
  recall?: (agentName: string, query: string) => Promise<MemoryEntry[]>;
}

export class ConversationSystem {
  private readonly bus: ConversationOpts["bus"];
  private readonly now: ConversationOpts["now"];
  private readonly live: ConversationOpts["live"];
  private readonly router: ConversationOpts["router"];
  private readonly affinityText: NonNullable<ConversationOpts["affinityText"]>;
  private readonly writeMemory: ConversationOpts["writeMemory"];
  private readonly recall: ConversationOpts["recall"];

  constructor(opts: ConversationOpts) {
    this.bus = opts.bus;
    this.now = opts.now;
    this.live = opts.live;
    this.router = opts.router;
    this.affinityText = opts.affinityText ?? (() => "");
    this.writeMemory = opts.writeMemory;
    this.recall = opts.recall;
  }

  /**
   * Called from CognitionSystem.onTalk after the existing affinity/diffusion
   * logic. Runs the multi-turn exchange, handles display + memory + feed.
   * Fire-and-forget: never blocks, never throws into the caller.
   *
   * Signature UNCHANGED from v2 (frozen wiring): (speaker, listener, say).
   */
  handleReply(speaker: Agent, listener: Agent, say: string): void {
    // Trim whitespace; treat blank says as missing.
    const trimmed = say.trim();
    if (!trimmed) return;
    // Earshot guard (checked once at start): the pair must be adjacent.
    try {
      if (chebyshev(speaker.pos, listener.pos) > 1) return;
    } catch {
      return;
    }

    void this._run(speaker, listener, trimmed).catch(() => {});
  }

  /**
   * Drive the alternating exchange. Turn 0 is A's opener; B replies on turn 1,
   * A on turn 2, and so on, strictly alternating, until MAX_TURNS, a closer, or
   * an empty reply. Then commit memory + feed + bubbles exactly once.
   */
  private async _run(
    speaker: Agent,
    listener: Agent,
    say: string,
  ): Promise<void> {
    try {
      const turns: ConversationTurn[] = [{ speaker: speaker.name, text: say }];

      // turn 1 = B, turn 2 = A, turn 3 = B, … strict alternation. The mock
      // variant is indexed by the RESPONDER's own reply count (0-based) so each
      // side's FIRST reply is turnIndex 0 — byte-identical to the v2 template
      // (keeps the legacy "I told …" memory assertions green) — while later
      // replies from the same side cycle through the variant array.
      for (let turn = 1; turn < MAX_TURNS; turn++) {
        const responder = turn % 2 === 1 ? listener : speaker;
        const other = turn % 2 === 1 ? speaker : listener;
        const replyIndex = Math.floor((turn - 1) / 2);
        const text = await this._oneTurn(responder, other, turns, replyIndex);
        if (!text) break; // empty reply ends the conversation
        turns.push({ speaker: responder.name, text });
        if (CLOSER_RE.test(text)) break; // natural close
      }

      this._commit(speaker, listener, turns);
    } catch {
      // Defensive: at minimum, commit the opener + a single mock reply.
      try {
        const fallback = mockReply(
          listener.persona.description,
          speaker.name,
          say,
          1,
        );
        this._commit(speaker, listener, [
          { speaker: speaker.name, text: say },
          { speaker: listener.name, text: fallback },
        ]);
      } catch {
        /* absolute last resort: silently swallow */
      }
    }
  }

  /**
   * Generate one reply for `responder` (live → fast tier, mock fallback).
   * Sanitizes (strip surrounding quotes, slice ~120). Returns "" only when even
   * the mock fallback is empty (shouldn't happen) — the loop treats "" as a
   * natural stop.
   */
  private async _oneTurn(
    responder: Agent,
    other: Agent,
    turns: ConversationTurn[],
    turnIndex: number,
  ): Promise<string> {
    // Ground the reply in what `responder` knows/heard about `other`. When no
    // recall dep is wired (every frozen test), `ideas` is "" and BOTH branches
    // below are byte-identical to today.
    const ideas = await this._recallIdeas(responder, other);

    let reply: string;
    try {
      reply = this.live()
        ? await this._liveReply(responder, other, turns, turnIndex, ideas)
        : ideas
          ? mockTopicalReply(responder.persona.description, other.name, ideas, turnIndex)
          : mockReply(responder.persona.description, other.name, lastText(turns), turnIndex);
    } catch {
      reply = mockReply(responder.persona.description, other.name, lastText(turns), turnIndex);
    }

    reply = sanitize(reply);
    if (!reply) {
      reply = sanitize(
        mockReply(responder.persona.description, other.name, lastText(turns), turnIndex),
      );
    }
    return reply;
  }

  /**
   * Smallville `new_retrieve(focal=other)`: pull `responder`'s top memories
   * about `other` and render a short deterministic ideas gist. Fire-and-forget
   * never-throw: on a missing dep, a recall throw, or an empty result, returns
   * "" so `_oneTurn` degrades to the generic reply (additive). READS only — no
   * new memories are written this slice.
   */
  private async _recallIdeas(responder: Agent, other: Agent): Promise<string> {
    if (!this.recall) return "";
    try {
      const mems = await this.recall(responder.name, other.name);
      return renderIdeas(mems ?? []);
    } catch {
      return "";
    }
  }

  private async _liveReply(
    responder: Agent,
    other: Agent,
    turns: ConversationTurn[],
    turnIndex: number,
    ideas = "",
  ): Promise<string> {
    try {
      const affinity = this.affinityText(responder.name, other.name);
      const { system, user } = buildReplyPrompt({
        selfPersona: responder.persona.description,
        selfName: responder.name,
        otherName: other.name,
        affinitySummary: affinity,
        transcriptTail: turns.slice(-TRANSCRIPT_TAIL),
        ideas,
      });

      const res = await this.router({
        agentId: responder.name,
        system,
        user,
        tier: "fast",
      });

      if (res.error || !res.raw?.trim()) {
        return mockReply(responder.persona.description, other.name, lastText(turns), turnIndex);
      }
      // The response is plain text (not JSON), take the first non-empty line.
      const firstLine = res.raw.trim().split("\n")[0]?.trim() ?? "";
      return firstLine || mockReply(responder.persona.description, other.name, lastText(turns), turnIndex);
    } catch {
      return mockReply(responder.persona.description, other.name, lastText(turns), turnIndex);
    }
  }

  /**
   * Commit the completed exchange exactly once: ONE legacy memory pair (NOT per
   * turn), sequential reply bubbles, and a single "conversation" WorldEvent.
   */
  private _commit(speaker: Agent, listener: Agent, turns: ConversationTurn[]): void {
    const t = this.now();
    const aName = speaker.name;
    const bName = listener.name;
    const say = turns[0]?.text ?? "";
    // B's first reply (turn 1) drives the legacy memory + feed fields.
    const reply = turns[1]?.text ?? "";

    // 1. Memory: ONE pair per conversation (B told A; A heard B's first reply).
    //    No per-turn memories — keeps gossip/diffusion dedup counts unchanged.
    if (reply) {
      try {
        this.writeMemory(bName, `I told ${aName}: "${reply}"`, 5);
        this.writeMemory(aName, `${bName} replied: "${reply}"`, 5);
      } catch {/* defensive */}

      // 1b. Conversation summary: ONE per participant (NOT per turn) — the gist
      //     of the whole exchange, a richer focal memory than the quoted line.
      //     Written at SUMMARY_IMPORTANCE (4), BELOW the gossip first-hand gate
      //     (the gossip first-hand gate `importance < 5`), so summaries are gossip-inert —
      //     they ground recall + reflection but never become rumors. Fire-and-
      //     forget: a summarize/write failure must never throw into the loop.
      try {
        const sumA = summarizeConversation(aName, bName, turns);
        const sumB = summarizeConversation(bName, aName, turns);
        if (sumA) this.writeMemory(aName, sumA, SUMMARY_IMPORTANCE);
        if (sumB) this.writeMemory(bName, sumB, SUMMARY_IMPORTANCE);
      } catch {/* defensive */}
    }

    // 2. Delayed bubbles: show every turn ≥ 1 sequentially, each in try/catch.
    //    First reply at REPLY_BUBBLE_DELAY_MS; each subsequent +TURN_GAP_MS.
    for (let k = 1; k < turns.length; k++) {
      const turn = turns[k];
      const delay = REPLY_BUBBLE_DELAY_MS + (k - 1) * TURN_GAP_MS;
      try {
        setTimeout(() => {
          try {
            getRenderApi()?.showSpeech(turn.speaker, turn.text);
          } catch {/* no-op: render may be gone */}
        }, delay);
      } catch {/* defensive */}
    }

    // 3. Feed event: "conversation" kind — backward compatible legacy fields
    //    plus the full turns[] transcript and a stable conversationId.
    try {
      const conversationId = `${aName}|${bName}|${t.day}|${t.phase}`;
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
          turns,
          conversationId,
        },
      });
    } catch {/* defensive */}
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip leading/trailing quotes, trim, truncate to 120 chars. */
function sanitize(text: string): string {
  return text.replace(/^["']+|["']+$/g, "").trim().slice(0, 120);
}

/** The most recent line's text (for mock context / continuity). */
function lastText(turns: ConversationTurn[]): string {
  return turns.length > 0 ? turns[turns.length - 1].text : "";
}
