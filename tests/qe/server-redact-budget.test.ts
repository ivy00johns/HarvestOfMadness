/**
 * QE adversarial suite — server error sanitization honesty + budget boundary.
 *
 * The builders' redact tests cover the happy patterns; these attack the
 * boundaries: exact 240-char cap, keys smuggled inside URLs/JSON blobs,
 * multiple keys per message, and the budget counter's exact ceiling edge +
 * UTC midnight rollover via an injected clock.
 */
import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../../server/llm/redact";
import { createBudget } from "../../server/llm/budget";

describe("sanitizeErrorMessage — cap honesty", () => {
  it("caps at exactly 240 chars, never more", () => {
    for (const len of [239, 240, 241, 500, 10_000]) {
      const out = sanitizeErrorMessage("e".repeat(len));
      expect(out.length, `input len ${len}`).toBeLessThanOrEqual(240);
      if (len <= 240) expect(out).toBe("e".repeat(len)); // no premature trunc
      else expect(out.endsWith("...")).toBe(true);
    }
  });

  it("collapse-then-cap: huge whitespace padding cannot smuggle length past the cap", () => {
    const out = sanitizeErrorMessage(("word" + " ".repeat(100)).repeat(200));
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out).not.toMatch(/ {2}/);
  });
});

describe("sanitizeErrorMessage — key smuggling", () => {
  const KEY = "freellmapi-AbCdEf123456789012345678";

  it("redacts a freellmapi key in plain prose", () => {
    expect(sanitizeErrorMessage(`auth failed for ${KEY} upstream`)).not.toContain(KEY);
  });

  it("redacts a key inside a URL (URL rule must not leak the key first)", () => {
    const out = sanitizeErrorMessage(`fetch http://127.0.0.1:3001/v1/chat?key=${KEY} failed`);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("127.0.0.1:3001");
  });

  it("redacts multiple keys of mixed vendors in one message", () => {
    const msg = `tried ${KEY}, sk-abcdefgh12345678, gsk_abcdefgh12345678, AIzaSyA1234567890abcdefghij — all failed`;
    const out = sanitizeErrorMessage(msg);
    for (const leak of [KEY, "sk-abcdefgh12345678", "gsk_abcdefgh12345678", "AIzaSyA1234567890abcdefghij"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("redacts a key inside a JSON error blob (quoted, colon-separated)", () => {
    const out = sanitizeErrorMessage(`{"api_key": "${KEY}", "detail": "denied"}`);
    expect(out).not.toContain(KEY);
  });

  it("redacts Authorization header echoes", () => {
    const out = sanitizeErrorMessage(`request had Authorization: Bearer ${KEY} and was rejected`);
    expect(out).not.toContain(KEY);
  });

  it("a key at the truncation boundary cannot survive partially intact", () => {
    // Put the key right where the 240-char cut lands; redaction runs BEFORE
    // the cap, so no fragment longer than the redaction placeholder leaks.
    const msg = "x".repeat(230) + " " + KEY + " tail";
    const out = sanitizeErrorMessage(msg);
    expect(out).not.toContain("AbCdEf12345");
    expect(out.length).toBeLessThanOrEqual(240);
  });
});

describe("budget — exact ceiling edge + UTC midnight rollover (injected clock)", () => {
  it("consumes exactly `ceiling` then refuses; decisionsToday plateaus", () => {
    let now = Date.parse("2026-06-11T23:59:00Z");
    const budget = createBudget(3, () => now);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false); // 4th refused
    expect(budget.tryConsume()).toBe(false); // refusal has no side effects
    expect(budget.decisionsToday()).toBe(3);

    // One minute later it is the next UTC day: full ceiling available again.
    now += 60_000;
    expect(budget.decisionsToday()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.decisionsToday()).toBe(1);
  });

  it("23:59:59.999 -> 00:00:00.000 is the precise reset boundary", () => {
    let now = Date.parse("2026-06-11T23:59:59.999Z");
    const budget = createBudget(1, () => now);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    now += 1; // exactly midnight UTC
    expect(budget.tryConsume()).toBe(true);
  });

  it("clock moving within the same UTC day never resets", () => {
    let now = Date.parse("2026-06-11T00:00:01Z");
    const budget = createBudget(2, () => now);
    expect(budget.tryConsume()).toBe(true);
    now = Date.parse("2026-06-11T23:59:59Z");
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
  });
});
