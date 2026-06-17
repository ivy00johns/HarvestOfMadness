/**
 * Harvest of Madness — game bootstrap.
 *
 * The canvas fills the browser window via Phaser.Scale.RESIZE: the game
 * surface always equals the viewport (100vw x 100vh, no letterbox — see
 * index.html). The small tilemap (24*32 x 18*32 = 768x576, contract v2
 * TILE_SIZE 32) is framed by the spectator camera in WorldScene (default
 * zoom GAME_ZOOM, pan + wheel-zoom + click-to-follow). Both WorldScene and
 * the UIScene HUD re-layout on the Phaser RESIZE event. World + TimeSystem
 * singletons live in src/world/instance.ts (getWorld()) — import from there.
 *
 * W2 carve-out: obs-agent adds `import { UIScene } ...` and appends it to
 * the SCENES array below. Keep that the only edit this file needs.
 */
import Phaser from "phaser";
import { BACKGROUND_COLOR } from "./config";
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
    // Canvas tracks the window; the camera (WorldScene) frames the map.
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: "100%",
    height: "100%",
  },
  scene: SCENES,
});
