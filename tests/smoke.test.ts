import { describe, expect, it } from "vitest";
import { CROPS } from "@contracts/types";

describe("scaffold smoke", () => {
  it("resolves @contracts alias and reads authoritative crop data", () => {
    expect(CROPS.parsnip.days).toBe(4);
  });
});
