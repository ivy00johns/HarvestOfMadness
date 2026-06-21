/**
 * Gossip distortion (INTENSIFY) — Wave 4c (C2) — the payoff, through the REAL
 * Cognition.onTalk relay (same harness as gossip.test.ts).
 *
 * Proves the structure↔distortion coupling:
 *   - A→B→C→D: B's hop-1 memory is BYTE-IDENTICAL to today (faithful); C's
 *     hop-2 and D's hop-3 memories carry the ESCALATING intensified claim, with
 *     hop2→hop3 escalation visible.
 *   - The structured fields are pinned: every relay memory carries
 *     subject === <first-hand author> (UNCHANGED across hops) and
 *     claim === <canonical gist> (UNCHANGED across hops), while the rendered
 *     `text` differs by hop.
 *   - Distortion does NOT compound: D's stored meta.claim === the canonical gist
 *     (NOT C's distorted text) — proves the read-from-meta rule.
 *   - Determinism: identical relay schedules → identical texts/subjects/claims.
 *   - Structured bus payload: the "gossip" event carries { subject, claim }.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventBus, GameStamp, MemoryEntry, Vec2, WorldEvent } from "@contracts/types";
import { Agent } from "../../src/agents/Agent";
import { CognitionSystem } from "../../src/agents/Cognition";
import { intensifyClaim } from "../../src/agents/rumor";
import { resetWorldForTests } from "../../src/world/instance";

const CANONICAL = "I found a treasure chest buried near the well";

function makeStampBus(): { bus: EventBus; events: WorldEvent[] } {
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

function makeAgent(name: string, pos: Vec2 = { x: 5, y: 5 }): Agent {
  return new Agent({
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: `${name} — test agent`,
    color: 0xffffff,
    start: pos,
  });
}

function makeCognition(): { cog: CognitionSystem; events: WorldEvent[] } {
  const { bus, events } = makeStampBus();
  const now: () => GameStamp = () => ({ day: 1, phase: "morning" });
  const cog = new CognitionSystem({ bus, live: () => false, now });
  return { cog, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function gossipMemsOf(cog: CognitionSystem, name: string): MemoryEntry[] {
  return cog.memory.all(name).filter((m) => m.origin !== undefined);
}

describe("gossip distortion (INTENSIFY) — through real Cognition.onTalk", () => {
  beforeEach(() => {
    resetWorldForTests();
  });

  it("A→B→C→D: hop-1 byte-identical, hop-2 & hop-3 carry escalating intensified claim", async () => {
    const { cog } = makeCognition();
    const [a, b, c, d] = ["A", "B", "C", "D"].map((n) => makeAgent(n));
    [a, b, c, d].forEach((ag) => cog.registerAgent(ag));

    const src = await cog.write("A", "observation", CANONICAL, 9);
    const originId = src!.id;

    cog.onTalk(a, b, "");
    await settle();
    cog.onTalk(b, c, "");
    await settle();
    cog.onTalk(c, d, "");
    await settle();

    const bMem = gossipMemsOf(cog, "B")[0];
    const cMem = gossipMemsOf(cog, "C")[0];
    const dMem = gossipMemsOf(cog, "D")[0];

    // Hop 1 — BYTE-IDENTICAL to the legacy faithful first-hand share.
    expect(bMem.hop).toBe(1);
    expect(bMem.text).toBe(`A mentioned: ${CANONICAL}`);

    // Hop 2 — intensified claim inside the relay wrapper.
    expect(cMem.hop).toBe(2);
    expect(cMem.text).toBe(
      `B mentioned (heard from A): ${intensifyClaim(CANONICAL, 2)}`,
    );

    // Hop 3 — escalated intensified claim.
    expect(dMem.hop).toBe(3);
    expect(dMem.text).toBe(
      `C mentioned (heard from B): ${intensifyClaim(CANONICAL, 3)}`,
    );

    // Escalation hop2 → hop3 is VISIBLE in the rendered text.
    expect(dMem.text.length).toBeGreaterThan(cMem.text.length);
    expect(intensifyClaim(CANONICAL, 3)).not.toBe(intensifyClaim(CANONICAL, 2));

    // Subject UNCHANGED across hops — the telephone keeps WHO (first-hand author).
    expect(bMem.subject).toBe("A");
    expect(cMem.subject).toBe("A");
    expect(dMem.subject).toBe("A");

    // Canonical claim UNCHANGED across hops (the stored gist never distorts).
    expect(bMem.claim).toBe(CANONICAL);
    expect(cMem.claim).toBe(CANONICAL);
    expect(dMem.claim).toBe(CANONICAL);

    // Origin propagates unchanged (existing invariant, kept).
    expect(bMem.origin).toBe(originId);
    expect(dMem.origin).toBe(originId);
  });

  it("distortion does NOT compound: D's meta.claim is the canonical gist, not C's distorted text", async () => {
    const { cog } = makeCognition();
    const [a, b, c, d] = ["A", "B", "C", "D"].map((n) => makeAgent(n));
    [a, b, c, d].forEach((ag) => cog.registerAgent(ag));

    await cog.write("A", "observation", CANONICAL, 9);

    cog.onTalk(a, b, "");
    await settle();
    cog.onTalk(b, c, "");
    await settle();
    cog.onTalk(c, d, "");
    await settle();

    const cMem = gossipMemsOf(cog, "C")[0];
    const dMem = gossipMemsOf(cog, "D")[0];

    // The KEY no-compounding assertion: D read C's META claim (canonical), NOT
    // C's distorted rendered text. If distortion compounded, D.claim would be
    // C's hop-2 intensified string.
    expect(dMem.claim).toBe(CANONICAL);
    expect(dMem.claim).not.toBe(cMem.text);
    expect(dMem.claim).not.toContain("word is,");
    expect(dMem.claim).not.toContain("the whole town swears");

    // And D's hop-3 rendered text is derived from the CANONICAL claim at hop 3,
    // never from C's already-distorted hop-2 string.
    expect(dMem.text).toBe(
      `C mentioned (heard from B): ${intensifyClaim(CANONICAL, 3)}`,
    );
    expect(dMem.text).not.toContain(intensifyClaim(CANONICAL, 2));
  });

  it("determinism: identical relay schedules → identical texts/subjects/claims/hops", async () => {
    const runOnce = async () => {
      resetWorldForTests();
      const { cog } = makeCognition();
      const [a, b, c, d] = ["A", "B", "C", "D"].map((n) => makeAgent(n));
      [a, b, c, d].forEach((ag) => cog.registerAgent(ag));
      await cog.write("A", "observation", CANONICAL, 9);
      cog.onTalk(a, b, "");
      await settle();
      cog.onTalk(b, c, "");
      await settle();
      cog.onTalk(c, d, "");
      await settle();
      return ["B", "C", "D"].map((n) => {
        const m = gossipMemsOf(cog, n)[0];
        return {
          name: n,
          text: m.text,
          subject: m.subject,
          claim: m.claim,
          hop: m.hop,
          importance: m.importance,
        };
      });
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
  });

  it("structured bus payload: the 'gossip' event carries { subject, claim }", async () => {
    const { cog, events } = makeCognition();
    const [a, b] = ["A", "B"].map((n) => makeAgent(n));
    [a, b].forEach((ag) => cog.registerAgent(ag));

    await cog.write("A", "observation", CANONICAL, 9);
    cog.onTalk(a, b, "");
    await settle();

    const gossipEvent = events.find((e) => e.kind === "gossip");
    expect(gossipEvent).toBeDefined();
    const payload = gossipEvent!.payload as {
      origin?: string;
      hop?: number;
      subject?: string;
      claim?: string;
    };
    expect(payload.subject).toBe("A");
    expect(payload.claim).toBe(CANONICAL);
    expect(payload.hop).toBe(1);
  });
});
