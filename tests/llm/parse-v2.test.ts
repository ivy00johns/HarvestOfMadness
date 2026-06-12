/**
 * v2 parse extensions — GIVE_GIFT / EMOTE actions + the optional emotion
 * enum. v1 behavior is covered by tests/llm/parse.test.ts (no regression).
 */
import { describe, expect, it } from "vitest";
import { parseAgentAction } from "../../src/llm/parse";

describe("parseAgentAction — GIVE_GIFT", () => {
  it("parses a valid gift with {agentName, itemId, qty}", () => {
    const a = parseAgentAction(
      '{"thought":"Rusty deserves this","say":"For you!","action":"GIVE_GIFT","target":{"agentName":"Rusty","itemId":"crop:parsnip","qty":1}}',
    );
    expect(a).toEqual({
      thought: "Rusty deserves this",
      say: "For you!",
      action: "GIVE_GIFT",
      target: { agentName: "Rusty", itemId: "crop:parsnip", qty: 1 },
    });
  });

  it("rejects a gift missing any of agentName/itemId/qty", () => {
    expect(
      parseAgentAction('{"action":"GIVE_GIFT","target":{"itemId":"crop:parsnip","qty":1}}'),
    ).toBeNull();
    expect(
      parseAgentAction('{"action":"GIVE_GIFT","target":{"agentName":"Rusty","qty":1}}'),
    ).toBeNull();
    expect(
      parseAgentAction('{"action":"GIVE_GIFT","target":{"agentName":"Rusty","itemId":"crop:parsnip"}}'),
    ).toBeNull();
  });

  it("rejects a gift with wrong-typed fields, a Vec2 target, or no target", () => {
    expect(
      parseAgentAction(
        '{"action":"GIVE_GIFT","target":{"agentName":"Rusty","itemId":"crop:parsnip","qty":"one"}}',
      ),
    ).toBeNull();
    expect(parseAgentAction('{"action":"GIVE_GIFT","target":{"x":1,"y":2}}')).toBeNull();
    expect(parseAgentAction('{"action":"GIVE_GIFT"}')).toBeNull();
  });

  it("parses a fenced GIVE_GIFT with prose around it (defensive extraction)", () => {
    const raw =
      'Here you go!\n```json\n{"thought":"gift","say":null,"action":"GIVE_GIFT","target":{"agentName":"Mona","itemId":"crop:potato","qty":1}}\n```';
    const a = parseAgentAction(raw);
    expect(a?.action).toBe("GIVE_GIFT");
    expect(a?.target).toEqual({ agentName: "Mona", itemId: "crop:potato", qty: 1 });
  });
});

describe("parseAgentAction — EMOTE", () => {
  it("parses EMOTE without a target", () => {
    const a = parseAgentAction('{"thought":"so happy","say":null,"action":"EMOTE","emotion":"happy"}');
    expect(a).toEqual({ thought: "so happy", say: null, action: "EMOTE", emotion: "happy" });
  });

  it("drops a spurious target on EMOTE (like SLEEP/WAIT)", () => {
    const a = parseAgentAction('{"action":"EMOTE","target":{"x":9,"y":9}}');
    expect(a?.action).toBe("EMOTE");
    expect(a?.target).toBeUndefined();
  });
});

describe("parseAgentAction — emotion enum", () => {
  it("keeps each valid emotion", () => {
    for (const emotion of ["neutral", "happy", "annoyed", "sad", "excited"]) {
      const a = parseAgentAction(`{"action":"WAIT","emotion":"${emotion}"}`);
      expect(a?.emotion).toBe(emotion);
    }
  });

  it("leaves emotion undefined when absent (defaults downstream to neutral)", () => {
    expect(parseAgentAction('{"action":"WAIT"}')?.emotion).toBeUndefined();
  });

  it("rejects loudly on an invalid emotion value", () => {
    expect(parseAgentAction('{"action":"WAIT","emotion":"furious"}')).toBeNull();
    expect(parseAgentAction('{"action":"WAIT","emotion":42}')).toBeNull();
    expect(parseAgentAction('{"action":"WAIT","emotion":null}')).toBeNull();
  });

  it("accepts emotion on v1 actions too", () => {
    const a = parseAgentAction(
      '{"action":"WATER","target":{"x":1,"y":2},"emotion":"annoyed"}',
    );
    expect(a?.action).toBe("WATER");
    expect(a?.emotion).toBe("annoyed");
  });
});
