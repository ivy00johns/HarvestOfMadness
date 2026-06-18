import { describe, expect, it } from "vitest";
import { createBudget } from "../../server/llm/budget";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("createBudget (UTC-day decision ceiling)", () => {
  it("consumes up to the ceiling then refuses without side effects", () => {
    const budget = createBudget(3, () => Date.UTC(2026, 5, 11, 12, 0, 0));
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.decisionsToday()).toBe(3);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.decisionsToday()).toBe(3); // refusals don't count
    expect(budget.ceiling).toBe(3);
  });

  it("resets when the UTC day rolls over", () => {
    let now = Date.UTC(2026, 5, 11, 23, 59, 0);
    const budget = createBudget(2, () => now);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);

    now += DAY_MS; // next UTC day
    expect(budget.decisionsToday()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.decisionsToday()).toBe(1);
  });

  it("does not reset within the same UTC day", () => {
    let now = Date.UTC(2026, 5, 11, 0, 0, 1);
    const budget = createBudget(1, () => now);
    expect(budget.tryConsume()).toBe(true);
    now += 12 * 60 * 60 * 1000; // same UTC day, 12h later
    expect(budget.tryConsume()).toBe(false);
  });

  it("a ceiling <= 0 means UNLIMITED: counts usage but never refuses", () => {
    for (const ceiling of [0, -1]) {
      const budget = createBudget(ceiling, () => Date.UTC(2026, 5, 11, 12, 0, 0));
      for (let i = 0; i < 1000; i++) expect(budget.tryConsume()).toBe(true);
      expect(budget.decisionsToday()).toBe(1000); // still tracked for /api/health
      expect(budget.ceiling).toBe(ceiling);
    }
  });
});
