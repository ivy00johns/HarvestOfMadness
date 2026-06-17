/**
 * v3 robustness port — structural truncation detection + progressive prefix
 * repair (deep-research-v3 lesson: judge the bytes, salvage the prefix when a
 * reasoning-model reroute chops the JSON tail). These cover the new PURE
 * helpers directly; parseAgentAction's truncation fallback is covered at the
 * end. v1/v2 parse behavior is unchanged (tests/llm/parse*.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  isStructurallyTruncated,
  parseAgentAction,
  repairTruncatedJson,
} from "../../src/llm/parse";

describe("isStructurallyTruncated", () => {
  it("a balanced object is not truncated", () => {
    expect(isStructurallyTruncated('{"action":"WAIT"}')).toBe(false);
    expect(isStructurallyTruncated('prefix {"a":{"b":1}} suffix')).toBe(false);
  });

  it("brace-free prose is not truncated (it is just prose, caller retries)", () => {
    expect(isStructurallyTruncated("sorry I cannot decide")).toBe(false);
    expect(isStructurallyTruncated("")).toBe(false);
  });

  it("an unclosed object is truncated", () => {
    expect(isStructurallyTruncated('{"action":"WAIT"')).toBe(true);
    expect(isStructurallyTruncated('{"thought":"long reasoning')).toBe(true);
    expect(isStructurallyTruncated('{"a":{"b":1}')).toBe(true);
  });

  it("a cut mid-string is truncated even if braces look balanced", () => {
    // string opens and never closes -> the closing-looking brace is inside it
    expect(isStructurallyTruncated('{"thought":"it was a }{ kind of day')).toBe(true);
  });

  it("ignores braces inside complete strings", () => {
    expect(isStructurallyTruncated('{"thought":"use {x,y}","action":"WAIT"}')).toBe(false);
  });
});

describe("repairTruncatedJson", () => {
  it("closes an object cut off mid-string, salvaging earlier fields", () => {
    const raw = '{"action":"WAIT","thought":"I was thinking about the wea';
    const obj = repairTruncatedJson(raw);
    expect(obj?.action).toBe("WAIT");
    expect(typeof obj?.thought).toBe("string");
  });

  it("salvages action/target when a trailing field is chopped", () => {
    const raw =
      '{"action":"WATER","target":{"x":3,"y":4},"thought":"the crop at (3,4) is parch';
    const obj = repairTruncatedJson(raw);
    expect(obj?.action).toBe("WATER");
    expect(obj?.target).toEqual({ x: 3, y: 4 });
  });

  it("backtracks past a half-written value to the last good field", () => {
    // thought complete, then a dangling "target":{ "x": ... cut off
    const raw = '{"action":"MOVE_TO","thought":"head east","target":{"x":7,"y":';
    const obj = repairTruncatedJson(raw);
    expect(obj?.action).toBe("MOVE_TO");
    expect(obj?.thought).toBe("head east");
  });

  it("drops a dangling key with no value", () => {
    const raw = '{"action":"WAIT","thought":';
    const obj = repairTruncatedJson(raw);
    expect(obj?.action).toBe("WAIT");
  });

  it("returns null when there is no object at all", () => {
    expect(repairTruncatedJson("just prose, no brace")).toBeNull();
  });

  it("never throws on hostile input", () => {
    expect(() => repairTruncatedJson("{".repeat(5000))).not.toThrow();
    expect(() => repairTruncatedJson('{"a":"' + "x".repeat(50_000))).not.toThrow();
  });
});

describe("parseAgentAction — truncation salvage", () => {
  it("salvages a valid action from a truncated response", () => {
    const raw =
      '{"action":"TILL","target":{"x":2,"y":2},"say":null,"thought":"this plot needs a good tilling before I can pl';
    const a = parseAgentAction(raw);
    expect(a?.action).toBe("TILL");
    expect(a?.target).toEqual({ x: 2, y: 2 });
  });

  it("still returns null when even the salvaged prefix has no action", () => {
    const raw = '{"thought":"I am still deciding what to do here and ran out of to';
    expect(parseAgentAction(raw)).toBeNull();
  });

  it("does NOT repair a balanced-but-invalid first object (caller retries)", () => {
    // first balanced block is invalid JSON; repair is truncation-only, so null
    expect(parseAgentAction('{"action": WAIT}')).toBeNull();
  });
});
