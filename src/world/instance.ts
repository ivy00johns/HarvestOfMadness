/**
 * World singletons — lazy so import order never matters and headless
 * consumers (tests, agent pipeline) can import without touching Phaser.
 */
import { World } from "./World";
import { TimeSystem } from "./TimeSystem";

let world: World | null = null;

export function getWorld(): World {
  if (!world) {
    world = new World(undefined, new TimeSystem());
  }
  return world;
}

export function getTimeSystem(): TimeSystem {
  return getWorld().timeSystem;
}

/** Test-only escape hatch. */
export function resetWorldForTests(): void {
  world = null;
}
