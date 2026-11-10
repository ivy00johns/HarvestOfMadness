---
title: "2. Phaser 4 + Tiled pipeline"
tags: ["2-phaser-4-tiled-pipeline"]
paths: [object/tile, maps/lpc_terrain.png, maps/farm.json, chars/abigail.png, NPCs/player, roofs/treetops, up/left/down/right, tilemap/sprite/camera/physics, shader/pipeline, render-nodes/Filters]
updated: 2026-11-10
---

Imported from `docs/deep-research-v2.md:47` by Andon (import docs/deep-research-v2.md:47 ef98507c405fba3f); the original stays there.

**Tiled setup.** Build one large orthogonal map (e.g., 100×100+ tiles). Use separate tile layers for draw order: `Ground` → `GroundDecor` → `Paths` → `Buildings` → `Overhead` (drawn above the player). Put a `Collisions` object/tile layer for solids. When exporting: **embed the tileset in the map**, keep layer data **uncompressed (CSV or Base64-uncompressed)**, export **JSON**. Critical Phaser constraint: the parser **does not support Tiled "Collection of Images" tilesets** — every layer's tiles must come from a **single tileset image**.

**Loading (Phaser 4, same API as v3):**

```js
preload() {
  this.load.image('tiles', 'maps/lpc_terrain.png');
  this.load.tilemapTiledJSON('farm', 'maps/farm.json');
  this.load.spritesheet('npc_abigail', 'chars/abigail.png',
    { frameWidth: 64, frameHeight: 64 });
}
create() {
  const map = this.make.tilemap({ key: 'farm' });
  const tileset = map.addTilesetImage('lpc_terrain', 'tiles'); // name must match Tiled
  const ground = map.createLayer('Ground', tileset, 0, 0);
  const buildings = map.createLayer('Buildings', tileset, 0, 0);
  const overhead = map.createLayer('Overhead', tileset, 0, 0);
  overhead.setDepth(1000); // render above characters
}
```

**Collision.** Two common approaches: (a) `ground.setCollisionByProperty({ collides: true })` after marking tiles in Tiled's tileset editor; or (b) a dedicated layer with `setCollisionByExclusion([-1])`. Then `this.physics.add.collider(player, buildings)`. Visualize with `map.renderDebug`.

**Animated water.** Phaser's Tilemap API does **not** natively play Tiled's per-tile animations, so iterate the water layer and swap tile indices on a timer (a `time.addEvent` loop cycling frames), or convert water to sprites. This is a well-documented community pattern.

**Depth sorting.** For a top-down game, set each character's depth to its `y` (`sprite.setDepth(sprite.y)`) every frame so NPCs/player occlude correctly with each other; keep the `Overhead` layer at a fixed high depth for roofs/treetops.

**Camera over a large map.** `this.cameras.main.setBounds(0,0, map.widthInPixels, map.heightInPixels); this.cameras.main.startFollow(player, true, 0.1, 0.1);` and `this.physics.world.setBounds(...)`. Use `pixelArt: true` + `roundPixels: true` in game config and integer zoom to keep pixels crisp.

**Character animations.** Define 4 directional walk anims from the spritesheet:

```js
this.anims.create({ key: 'abigail-walk-down',
  frames: this.anims.generateFrameNumbers('npc_abigail', { start: 0, end: 7 }),
  frameRate: 10, repeat: -1 });
```

LPC rows map to directions (up/left/down/right). In `update`, pick the anim by movement vector and `stop()` on idle.

**Phaser 4 specifics.** Use WebGL (Canvas is deprecated). Standard tilemap/sprite/camera/physics code from v3 tutorials works unchanged. If you copied any custom shader/pipeline or used `setTintFill`/`Geom.Point`/`Math.TAU`/FX/Masks, port them to render-nodes/Filters/`setTint`+`setTintMode`. There is also an optional GPU tilemap layer (orthographic only) and `SpriteGPULayer` for huge sprite counts.
