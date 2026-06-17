import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../server/llm/redact";

describe("sanitizeErrorMessage", () => {
  it("strips freellmapi unified keys", () => {
    const out = sanitizeErrorMessage("invalid key freellmapi-abc123DEF456ghi was rejected");
    expect(out).not.toContain("freellmapi-abc123DEF456ghi");
    expect(out).toContain("[redacted-key]");
  });

  it("strips sk-/gsk_/AIza vendor keys", () => {
    const out = sanitizeErrorMessage(
      "tried sk-aaaabbbbcccc1111 then gsk_ddddeeeeffff2222 then AIzaSyA1234567890abcdefghij",
    );
    expect(out).not.toMatch(/sk-aaaabbbbcccc1111|gsk_ddddeeeeffff2222|AIzaSyA1234567890abcdefghij/);
  });

  it("strips Bearer tokens and URLs", () => {
    const out = sanitizeErrorMessage(
      "POST http://127.0.0.1:3001/v1/chat/completions failed with Bearer abc.def-ghi",
    );
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("abc.def-ghi");
    expect(out).toContain("[redacted-url]");
    expect(out).toContain("Bearer [redacted]");
  });

  it("caps at 240 chars and collapses whitespace", () => {
    const out = sanitizeErrorMessage(`a   b\n\nc ${"x".repeat(500)}`);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.startsWith("a b c")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
  });

  it("never returns an empty message and tolerates non-strings", () => {
    expect(sanitizeErrorMessage("")).toBe("Upstream error");
    expect(sanitizeErrorMessage(undefined)).toBe("Upstream error");
    expect(sanitizeErrorMessage(42)).toBe("42");
  });
});
