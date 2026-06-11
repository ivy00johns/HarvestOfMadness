/**
 * Economy — §7 price tables derived from the contract CROPS constants.
 * Pure lookups; gold/inventory mutation belongs to the action executor.
 */
import { CROPS, type CropKind } from "@contracts/types";

export function buildBuyPrices(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of Object.keys(CROPS) as CropKind[]) {
    out[`seed:${kind}`] = CROPS[kind].seedCost;
  }
  return out;
}

export function buildSellPrices(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of Object.keys(CROPS) as CropKind[]) {
    out[`crop:${kind}`] = CROPS[kind].sellPrice;
  }
  return out;
}
