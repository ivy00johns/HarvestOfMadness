/**
 * Scripted demo (mission §14 phase 2 proof): drives the full farm loop over
 * WorldApi with no agents — till -> plant -> water -> sleep x4 -> harvest ->
 * sell-value log. Runs ONLY when VITE_SCRIPTED_DEMO === "1" (guarded by the
 * caller, WorldScene). No Phaser imports — tile changes show up through the
 * World onChange feed the scene already subscribes to.
 */
import type { WorldApi } from "@contracts/types";
import { CROPS } from "@contracts/types";
import { FIELD_RECT } from "./map";

const STEP_DELAY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runScriptedDemo(
  world: WorldApi,
  stepDelayMs: number = STEP_DELAY_MS,
): Promise<void> {
  const log = (msg: string): void => console.log(`[scripted-demo] ${msg}`);
  const wait = (): Promise<void> => sleep(stepDelayMs);
  const plots = [
    { x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 + 1 },
    { x: FIELD_RECT.x0 + 2, y: FIELD_RECT.y0 + 1 },
    { x: FIELD_RECT.x0 + 3, y: FIELD_RECT.y0 + 1 },
  ];

  log(`starting on day ${world.time().day} (${world.time().phase})`);

  for (const p of plots) {
    const r = world.till(p);
    log(`till (${p.x},${p.y}) -> ${r.ok ? "ok" : `REJECTED: ${r.reason}`}`);
    await wait();
  }

  for (const p of plots) {
    const r = world.plant(p, "parsnip");
    log(
      `plant parsnip (${p.x},${p.y}) -> ${r.ok ? "ok" : `REJECTED: ${r.reason}`}`,
    );
    await wait();
  }

  for (let day = 0; day < CROPS.parsnip.days; day++) {
    for (const p of plots) {
      const r = world.water(p);
      log(`water (${p.x},${p.y}) -> ${r.ok ? "ok" : `REJECTED: ${r.reason}`}`);
    }
    await wait();
    world.advanceDay();
    log(`SLEEP -> day ${world.time().day} (${world.time().phase})`);
    await wait();
  }

  let totalValue = 0;
  const sells = world.sellPrices();
  for (const p of plots) {
    const r = world.harvest(p);
    if (r.ok && r.itemId) {
      const value = sells[r.itemId] ?? 0;
      totalValue += value;
      log(`harvest (${p.x},${p.y}) -> ok, got ${r.itemId} worth ${value}g`);
    } else {
      log(`harvest (${p.x},${p.y}) -> REJECTED: ${r.reason}`);
    }
    await wait();
  }

  const seedSpend = plots.length * world.buyPrices()["seed:parsnip"];
  log(
    `done: sell value ${totalValue}g, seed cost ${seedSpend}g, ` +
      `net ${totalValue - seedSpend}g`,
  );
}
