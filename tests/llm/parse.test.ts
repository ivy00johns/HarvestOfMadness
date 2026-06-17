import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, parseAgentAction } from "../../src/llm/parse";

describe("extractFirstJsonObject", () => {
  it("returns a bare JSON object untouched", () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"action":"WAIT"}\n```';
    expect(extractFirstJsonObject(raw)).toBe('{"action":"WAIT"}');
  });

  it("takes the first balanced object out of surrounding prose", () => {
    const raw = 'Sure! Here is my move: {"a":{"b":2}} hope that helps {"c":3}';
    expect(extractFirstJsonObject(raw)).toBe('{"a":{"b":2}}');
  });

  it("ignores braces inside JSON strings", () => {
    const raw = '{"thought":"use {x,y} coords"}';
    expect(extractFirstJsonObject(raw)).toBe('{"thought":"use {x,y} coords"}');
  });

  it("preserves backtick fences inside JSON string values (QE hardening)", () => {
    const raw = '{"thought":"wrap it in ```json fences```","say":null,"action":"WAIT"}';
    expect(extractFirstJsonObject(raw)).toBe(raw);
  });

  it("returns null when no object opens or closes", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject('{"unclosed":')).toBeNull();
  });
});

describe("parseAgentAction", () => {
  it("parses a clean action", () => {
    const a = parseAgentAction(
      '{"thought":"till it","say":null,"action":"TILL","target":{"x":3,"y":4}}',
    );
    expect(a).toEqual({ thought: "till it", say: null, action: "TILL", target: { x: 3, y: 4 } });
  });

  it("parses a fenced action with prose around it", () => {
    const raw =
      'Okay! My decision:\n```json\n{"thought":"sleep","say":"gn","action":"SLEEP"}\n```\nDone.';
    const a = parseAgentAction(raw);
    expect(a?.action).toBe("SLEEP");
    expect(a?.say).toBe("gn");
  });

  it("keeps thought/say verbatim when they contain fence markers (QE hardening)", () => {
    const a = parseAgentAction(
      '{"thought":"wrap it in ```json fences","say":"```","action":"TILL","target":{"x":3,"y":4}}',
    );
    expect(a?.thought).toBe("wrap it in ```json fences");
    expect(a?.say).toBe("```");
    expect(a?.action).toBe("TILL");
    expect(a?.target).toEqual({ x: 3, y: 4 });
  });

  it("defaults thought to empty string and say to null", () => {
    const a = parseAgentAction('{"action":"WAIT"}');
    expect(a).toEqual({ thought: "", say: null, action: "WAIT" });
  });

  it("keeps goal only when it is a string", () => {
    expect(parseAgentAction('{"action":"WAIT","goal":"get rich"}')?.goal).toBe("get rich");
    expect(parseAgentAction('{"action":"WAIT","goal":42}')?.goal).toBeUndefined();
  });

  it("rejects garbage, non-objects, and unknown actions", () => {
    expect(parseAgentAction("complete garbage")).toBeNull();
    expect(parseAgentAction("[1,2,3]")).toBeNull();
    expect(parseAgentAction('{"action":"DANCE"}')).toBeNull();
    expect(parseAgentAction('{"thought":"no action field"}')).toBeNull();
  });

  it("requires a Vec2 target for position actions", () => {
    expect(parseAgentAction('{"action":"MOVE_TO"}')).toBeNull();
    expect(parseAgentAction('{"action":"MOVE_TO","target":{"x":"3","y":4}}')).toBeNull();
    expect(parseAgentAction('{"action":"HARVEST","target":{"itemId":"crop:parsnip","qty":1}}')).toBeNull();
    expect(parseAgentAction('{"action":"WATER","target":{"x":1,"y":2}}')?.target).toEqual({
      x: 1,
      y: 2,
    });
  });

  it("requires {itemId, qty} for BUY/SELL", () => {
    expect(parseAgentAction('{"action":"BUY","target":{"x":1,"y":2}}')).toBeNull();
    expect(
      parseAgentAction('{"action":"SELL","target":{"itemId":"crop:parsnip","qty":2}}')?.target,
    ).toEqual({ itemId: "crop:parsnip", qty: 2 });
  });

  it("requires {agentName} for TALK_TO", () => {
    expect(parseAgentAction('{"action":"TALK_TO","target":{"x":1,"y":1}}')).toBeNull();
    expect(parseAgentAction('{"action":"TALK_TO","target":{"agentName":"Rusty"}}')?.target).toEqual(
      { agentName: "Rusty" },
    );
  });

  it("drops the target for SLEEP/WAIT", () => {
    const a = parseAgentAction('{"action":"SLEEP","target":{"x":9,"y":9}}');
    expect(a?.action).toBe("SLEEP");
    expect(a?.target).toBeUndefined();
  });
});
