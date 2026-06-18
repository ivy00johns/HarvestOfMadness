/**
 * Diary LLM helpers — buildDiaryPrompt (plain-text, first-person, no fences)
 * and mockDiary (deterministic templated entry, sane on empty input).
 */
import { describe, expect, it } from "vitest";
import { buildDiaryPrompt } from "../../src/llm/prompts";
import { mockDiary } from "../../src/llm/mock";

describe("buildDiaryPrompt", () => {
  const prompt = buildDiaryPrompt("Dora", [
    "watered the parsnip",
    "Rusty gave me a gift",
  ]);

  it("embeds the agent name and every memory", () => {
    expect(prompt).toContain("Dora");
    expect(prompt).toContain("- watered the parsnip");
    expect(prompt).toContain("- Rusty gave me a gift");
  });

  it("asks for a short first-person entry as bare plain text", () => {
    expect(prompt).toContain("FIRST-PERSON");
    expect(prompt).toMatch(/1-2 sentences/);
    expect(prompt).toContain("no quotes, no JSON, no fences");
  });

  it("handles an empty memory list with a sane placeholder", () => {
    const bare = buildDiaryPrompt("Dora", []);
    expect(bare).toContain("nothing of note");
    expect(bare).toContain("Dora");
  });
});

describe("mockDiary", () => {
  const memories = [
    { text: "Watered the parsnip" },
    { text: "Rusty gave me a gift" },
    { text: "Sold 3 parsnips" },
  ];

  it("returns a first-person-flavored entry referencing the day's moments", () => {
    const r = mockDiary("Dora", memories);
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.text.toLowerCase()).toContain("journal");
    expect(r.text).toContain("3 moments");
  });

  it("yields a sane quiet-day entry on empty input", () => {
    const empty = mockDiary("Dora", []);
    expect(empty.text.length).toBeGreaterThan(0);
    expect(empty.text.toLowerCase()).toContain("quiet");
  });

  it("is deterministic and never throws on garbage", () => {
    expect(mockDiary("Dora", memories)).toEqual(mockDiary("Dora", memories));
    // garbage rows are filtered, not fatal
    const dirty = [
      { text: "real moment" },
      {} as { text: string },
      { text: "" },
    ];
    const a = mockDiary("Dora", dirty);
    const b = mockDiary("Dora", dirty);
    expect(a).toEqual(b);
    expect(a.text.length).toBeGreaterThan(0);
    expect(mockDiary("Dora", undefined as unknown as { text: string }[]).text.length).toBeGreaterThan(0);
  });

  it("differs across agents/memories (seeded variety)", () => {
    const single = mockDiary("Dora", [{ text: "watered the parsnip" }]);
    expect(single.text).toContain("1 moment");
    expect(single.text).not.toContain("1 moments");
  });
});
