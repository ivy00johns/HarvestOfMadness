import { describe, expect, it } from "vitest";
import { CROPS, type CropKind } from "@contracts/types";
import { World } from "../../src/world/World";

describe("Economy price tables (§7)", () => {
  it("buyPrices maps seed:<kind> to CROPS seedCost for every crop", () => {
    const buys = new World().buyPrices();
    for (const kind of Object.keys(CROPS) as CropKind[]) {
      expect(buys[`seed:${kind}`]).toBe(CROPS[kind].seedCost);
    }
    expect(Object.keys(buys)).toHaveLength(Object.keys(CROPS).length);
  });

  it("sellPrices maps crop:<kind> to CROPS sellPrice for every crop", () => {
    const sells = new World().sellPrices();
    for (const kind of Object.keys(CROPS) as CropKind[]) {
      expect(sells[`crop:${kind}`]).toBe(CROPS[kind].sellPrice);
    }
    expect(Object.keys(sells)).toHaveLength(Object.keys(CROPS).length);
  });

  it("matches the mission §7 authoritative numbers", () => {
    const w = new World();
    expect(w.buyPrices()).toEqual({
      "seed:parsnip": 20,
      "seed:potato": 50,
      "seed:cauliflower": 80,
    });
    expect(w.sellPrices()).toEqual({
      "crop:parsnip": 35,
      "crop:potato": 80,
      "crop:cauliflower": 175,
    });
  });

  it("returns defensive copies (mutating the result does not poison the table)", () => {
    const w = new World();
    const buys = w.buyPrices();
    buys["seed:parsnip"] = 1;
    expect(w.buyPrices()["seed:parsnip"]).toBe(20);
  });
});
