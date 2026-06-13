/**
 * Harvest of Madness — game bootstrap.
 *
 * Logical resolution is the tilemap (24*32 x 18*32 = 768x576, contract v2
 * TILE_SIZE 32), letterboxed/fit to the window; the whole map fits one
 * screen so no camera scroll is needed. World + TimeSystem singletons live
 * in src/world/instance.ts (getWorld()) — import from there, never construct.
 *
 * W2 carve-out: obs-agent adds `import { UIScene } ...` and appends it to
 * the SCENES array below. Keep that the only edit this file needs.
 */
import Phaser from "phaser";
import { MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "@contracts/types";
import { BACKGROUND_COLOR, GAME_ZOOM } from "./config";
import { BootScene } from "./scenes/BootScene";
import { WorldScene } from "./scenes/WorldScene";
import { UIScene } from "./scenes/UIScene";

const SCENES: Phaser.Types.Scenes.SceneType[] = [BootScene, WorldScene, UIScene];

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  pixelArt: true,
  roundPixels: true,
  backgroundColor: BACKGROUND_COLOR,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: MAP_WIDTH * TILE_SIZE,
    height: MAP_HEIGHT * TILE_SIZE,
    zoom: GAME_ZOOM,
    max: {
      width: MAP_WIDTH * TILE_SIZE * 2,
      height: MAP_HEIGHT * TILE_SIZE * 2,
    },
  },
  scene: SCENES,
});
