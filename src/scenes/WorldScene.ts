/**
 * WorldScene — owns ALL drawing. Implements the contract RenderApi; other
 * modules reach it via src/world/render.ts (set in create()).
 *
 * Two complete render paths (contract rule 15):
 *  - LPC assets (BootScene loaded everything in assets/manifest.json):
 *    real terrain/water/farm tiles, animated water, LPC walk-cycle
 *    characters, crop growth strips, house/shop facades, fences and trees.
 *  - v1 placeholder fallback (no/broken assets): colored rects via Graphics
 *    and labeled circles. The game must stay fully playable this way.
 *
 * The logical world (Grid/map.ts/WorldApi) is FROZEN — everything here is a
 * pure view of it. Visual dressing only sits on impassable tiles (wall ring,
 * building footprints); tree canopies overhang at overhead depth.
 */
import Phaser from "phaser";
import type {
  AssetManifest,
  CharacterAsset,
  Emotion,
  RenderApi,
  Tile,
  Vec2,
} from "@contracts/types";
import { CROPS, MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "@contracts/types";
import {
  CAMERA_FOLLOW_LERP,
  CAMERA_PAN_SPEED,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  CROP_COLORS,
  CROP_READY_COLOR,
  DEFAULT_ZOOM,
  EMOTE_DURATION_MS,
  EMOTION_STYLE,
  LABEL_FONT_SIZE,
  REG_ASSETS_ON,
  REG_ASSET_MANIFEST,
  SPEECH_DURATION_MS,
  SPEECH_FONT_SIZE,
  SPEECH_MAX_CHARS,
  TILE_COLORS,
  WALK_MS_PER_TILE,
  WATERED_SOIL_TINT,
  WATERED_TINT,
  WATER_ANIM_MS,
  zoomFactorForWheelDelta,
} from "../config";
import { computeHud, HUD_TOP_H, isPointOverHud, pointInRect, REG_HUD } from "../obs/layout";
import type { Rect } from "../obs/layout";
import { getWorld } from "../world/instance";
import { BUILDINGS, WORLD_OBJECTS } from "../world/map";
import { activityEmoji } from "../obs/activityEmoji";
import { buildingStyle } from "../obs/buildingStyle";
import {
  COBBLE_PATH_FRAMES,
  FURNITURE_FRAMES,
  INTERIOR_FRAMES,
  SIGN_FRAMES,
  SOIL_FRAMES,
  WATER_FRAMES,
  WELL_FRAMES,
  cropStripFrame,
  fenceFrame,
  setRenderApi,
  soilFrame,
  waterFrame,
} from "../world/render";
import { runScriptedDemo } from "../world/scriptedDemo";
import { CROP_TEXTURE_PREFIX } from "./BootScene";

// ---------------------------------------------------------------------------
// LPC frame maps (indices verified against the committed sheets)
// ---------------------------------------------------------------------------

/** terrain.png — 1024x2048, 32 frames/row. Row 12 = plain grass variants. */
const GRASS_FRAMES = [384, 385, 386];
/** terrain.png row 5 cols 0-2 — plain light-dirt tiles (paths). */
const PATH_FRAMES = [160, 161, 162];

/** house.png — 288x224, 9 frames/row. Red-brick facade + door/window props. */
const HOUSE_FRAMES = {
  TOP_L: 0, TOP_M: 1, TOP_R: 2,
  MID_L: 9, MID_M: 10, MID_R: 11,
  BASE_L: 18, BASE_M: 19, BASE_R: 20,
  DOOR_A_TOP: 3, DOOR_A_BOT: 12, // dark wood door (farmhouse)
  DOOR_B_TOP: 5, DOOR_B_BOT: 14, // light wood door (shop)
  WIN_TOP: 7, WIN_BOT: 16, // 32x64 dark window
} as const;

/** farming.png — 640x640, 20 frames/row. Row 10 = produce crates (market). */
const CRATE_FRAMES = [209, 211, 212]; // cabbage, potato, tomato crates

/** fruit-trees.png — sliced as 96x128 cells; full trees with shadows. */
const TREE_FRAMES = [0, 10];

/**
 * Decorative trees sit ON the impassable wall ring (y=17) so the dressing
 * never contradicts WorldApi.isPassable; canopies overhang interior grass at
 * overhead depth, which agents simply walk behind.
 */
const TREE_SPOTS: { x: number; y: number; frame: number }[] = [
  { x: 4, y: 17, frame: 0 },
  { x: 13, y: 17, frame: 10 },
  { x: 20, y: 17, frame: 0 },
];

/**
 * ALIAS map: CropKind "cauliflower" has no LPC strip in the manifest — the
 * turnip strip (a white-headed root crop) is the closest visual stand-in.
 * Unknown kinds with no strip and no alias fall back to a placeholder rect.
 */
const CROP_STRIP_ALIAS: Record<string, string> = {
  cauliflower: "turnip",
};

// ---------------------------------------------------------------------------
// Depth plan: base tiles 0, overlays 1, facades 2, props 3; crops + agents
// y-sorted in pixel space; tree canopies overhead; bubbles/emotes topmost.
// ---------------------------------------------------------------------------
const DEPTH_BASE = 0;
const DEPTH_OVERLAY = 1;
const DEPTH_FACADE = 2;
const DEPTH_PROP = 3;
const DEPTH_OVERHEAD = 10_000;
const DEPTH_BUBBLE = 20_000;

type Dir = "up" | "down" | "left" | "right";

interface AgentSprite {
  container: Phaser.GameObjects.Container;
  /** LPC sprite (assets mode) — null in placeholder mode */
  sprite: Phaser.GameObjects.Sprite | null;
  /** placeholder circle (fallback mode) — null in assets mode */
  circle: Phaser.GameObjects.Graphics | null;
  label: Phaser.GameObjects.Text;
  /** Smallville "pronunciatio" — persistent activity emoji above the name label */
  activityLabel: Phaser.GameObjects.Text;
  charKey: string | null;
  facing: Dir;
  tilePos: Vec2;
  speech: Phaser.GameObjects.Container | null;
  speechTimer: Phaser.Time.TimerEvent | null;
}

export class WorldScene extends Phaser.Scene implements RenderApi {
  private useAssets = false;
  private manifest: AssetManifest | null = null;

  /** placeholder-mode tile canvas */
  private tileGfx: Phaser.GameObjects.Graphics | null = null;

  /** assets-mode per-tile objects, keyed "x,y" */
  private readonly overlays = new Map<string, Phaser.GameObjects.Image>();
  private readonly cropSprites = new Map<
    string,
    Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
  >();
  /** open-water tiles cycling through WATER_FRAMES.ANIM */
  private readonly waterAnimTiles = new Map<string, Phaser.GameObjects.Image>();
  private waterFrameIdx = 0;

  private readonly agents = new Map<string, AgentSprite>();
  /** registration order preserved; character binding sorts a copy */
  private readonly agentNames: string[] = [];
  private unsubscribeWorld: (() => void) | null = null;

  // -- spectator camera (pan / wheel-zoom / click-to-follow) -----------------
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasd: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key> | null = null;
  private dragging = false;
  private dragMoved = false;
  private readonly dragStart = { px: 0, py: 0, scrollX: 0, scrollY: 0 };
  /** agent the camera is currently tracking, or null for free-pan */
  private following: string | null = null;

  constructor() {
    super("world");
  }

  create(): void {
    const world = getWorld();
    this.useAssets =
      this.registry.get(REG_ASSETS_ON) === true &&
      this.registry.get(REG_ASSET_MANIFEST) != null;
    this.manifest = this.useAssets
      ? (this.registry.get(REG_ASSET_MANIFEST) as AssetManifest)
      : null;

    this.setupCamera();

    if (this.useAssets) {
      this.buildBaseLayer();
      this.createCharacterAnims();
      this.dressBuildings();
      this.dressTrees();
      this.time.addEvent({
        delay: WATER_ANIM_MS,
        loop: true,
        callback: () => this.tickWater(),
      });
    } else {
      this.tileGfx = this.add.graphics();
      this.tileGfx.setDepth(DEPTH_BASE);
    }
    this.redrawAll();
    // v3 — draw world object markers over the tile layer (both asset + placeholder modes).
    this.dressWorldObjects();

    this.unsubscribeWorld = world.onChange((tiles) => {
      if (tiles === null) {
        this.redrawAll();
      } else {
        for (const p of tiles) this.drawTile(p.x, p.y);
      }
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.frameCamera, this);
      this.unsubscribeWorld?.();
      setRenderApi(null);
    });

    // Expose RenderApi to the agent pipeline (W2).
    setRenderApi(this);

    if (import.meta.env.VITE_SCRIPTED_DEMO === "1") {
      void runScriptedDemo(world);
    }
  }

  // -- spectator camera -------------------------------------------------------

  /**
   * Frame the map on a fullscreen canvas and wire pan/zoom/follow. The canvas
   * fills the window (Scale.RESIZE), so the camera (not the canvas) does all
   * framing: default zoom GAME_ZOOM centered on the map; mouse-wheel zoom
   * toward the cursor; click-drag or arrow/WASD to pan; click an agent to
   * follow them, click empty ground to stop following.
   */
  private setupCamera(): void {
    this.frameCamera();
    // The canvas is fullscreen (Scale.RESIZE) — re-frame whenever it changes.
    this.scale.on(Phaser.Scale.Events.RESIZE, this.frameCamera, this);

    this.cursors = this.input.keyboard?.createCursorKeys() ?? null;
    // Map WASD onto the directional names the pan code reads (up/down/left/
    // right). The comma-string form returns {W,A,S,D}, so `wasd.left` would be
    // undefined and `.isDown` would throw every frame — use the object form.
    this.wasd =
      (this.input.keyboard?.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        down: Phaser.Input.Keyboard.KeyCodes.S,
        right: Phaser.Input.Keyboard.KeyCodes.D,
      }) as typeof this.wasd) ?? null;

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onWorldPointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onWorldPointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onWorldPointerUp, this);
    this.input.on(Phaser.Input.Events.POINTER_WHEEL, this.onWorldWheel, this);
  }

  /**
   * Inset the world camera below the opaque HUD top bar (controls + kill-switch
   * badge) so the bar never covers the map. Default zoom = DEFAULT_ZOOM (1.5),
   * which shows ~24 tiles across a typical viewport — agents and buildings are
   * readable. On very small viewports we clamp down to CAMERA_ZOOM_MIN so the
   * whole map is still reachable. Re-runs on resize.
   */
  private frameCamera(): void {
    const cam = this.cameras.main;
    const w = this.scale.width;
    const viewH = Math.max(1, this.scale.height - HUD_TOP_H);
    const mapW = MAP_WIDTH * TILE_SIZE;
    const mapH = MAP_HEIGHT * TILE_SIZE;
    cam.setViewport(0, HUD_TOP_H, w, viewH);
    cam.setBounds(0, 0, mapW, mapH);
    // Use the configured DEFAULT_ZOOM for a readable starting view, but clamp
    // it so we never zoom in tighter than the map fills the viewport (no void),
    // and never lower than CAMERA_ZOOM_MIN.
    const zoom = Phaser.Math.Clamp(DEFAULT_ZOOM, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX);
    cam.setZoom(zoom);
    cam.centerOn(mapW / 2, mapH / 2);
  }

  /** True when a pointer position sits on HUD chrome (don't pan/select there). */
  private pointerOverHud(px: number, py: number): boolean {
    const hud = computeHud(this.scale.width, this.scale.height);
    if (isPointOverHud(hud, px, py)) return true;
    const panel = this.registry.get(REG_HUD) as Rect | null | undefined;
    return panel ? pointInRect(px, py, panel) : false;
  }

  private onWorldPointerDown(p: Phaser.Input.Pointer): void {
    if (this.pointerOverHud(p.x, p.y)) return;
    this.dragging = true;
    this.dragMoved = false;
    this.dragStart.px = p.x;
    this.dragStart.py = p.y;
    this.dragStart.scrollX = this.cameras.main.scrollX;
    this.dragStart.scrollY = this.cameras.main.scrollY;
  }

  private onWorldPointerMove(p: Phaser.Input.Pointer): void {
    if (!this.dragging || !p.isDown) return;
    const dx = p.x - this.dragStart.px;
    const dy = p.y - this.dragStart.py;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this.dragMoved = true;
      this.following = null; // dragging takes over from follow
      this.cameras.main.stopFollow();
    }
    const z = this.cameras.main.zoom;
    this.cameras.main.setScroll(
      this.dragStart.scrollX - dx / z,
      this.dragStart.scrollY - dy / z,
    );
  }

  private onWorldPointerUp(p: Phaser.Input.Pointer): void {
    const wasDrag = this.dragMoved;
    this.dragging = false;
    this.dragMoved = false;
    if (wasDrag || this.pointerOverHud(p.x, p.y)) return;
    // A clean click (no drag) on the world: follow the agent under it, else
    // clear any active follow.
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    const hit = this.agentAt(wp.x, wp.y);
    if (hit) {
      this.following = hit;
      const agent = this.agents.get(hit);
      if (agent) {
        this.cameras.main.startFollow(
          agent.container,
          false,
          CAMERA_FOLLOW_LERP,
          CAMERA_FOLLOW_LERP,
        );
      }
    } else if (this.following) {
      this.following = null;
      this.cameras.main.stopFollow();
    }
  }

  private onWorldWheel(p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number): void {
    if (this.pointerOverHud(p.x, p.y)) return;
    const cam = this.cameras.main;
    // Sample the world point under the cursor BEFORE changing zoom — used below
    // to keep that world point stationary under the cursor (cursor-anchored zoom).
    const before = cam.getWorldPoint(p.x, p.y);
    // Delta-proportional factor: exp(-dy * sensitivity).
    // dy>0 → scroll down → factor<1 (zoom out); dy<0 → zoom in.
    // A single mouse notch (dy≈100) gives factor≈0.86 (zoom out ×0.86 or in ×1.16).
    const z = Phaser.Math.Clamp(
      cam.zoom * zoomFactorForWheelDelta(dy),
      CAMERA_ZOOM_MIN,
      CAMERA_ZOOM_MAX,
    );
    cam.setZoom(z);
    // Re-sample the world point that now maps to the same screen pixel; scroll
    // by the difference so the world appears to zoom toward/away from the cursor.
    const after = cam.getWorldPoint(p.x, p.y);
    cam.setScroll(cam.scrollX + (before.x - after.x), cam.scrollY + (before.y - after.y));
  }

  /** Topmost agent whose ~1-tile body box contains the world point, or null. */
  private agentAt(wx: number, wy: number): string | null {
    let best: string | null = null;
    let bestY = -Infinity;
    const half = TILE_SIZE * 0.5;
    for (const [name, a] of this.agents) {
      const cx = a.container.x;
      const cy = a.container.y;
      // body box: roughly the tile under the feet up through the head sprite
      if (wx >= cx - half && wx <= cx + half && wy >= cy - TILE_SIZE * 1.6 && wy <= cy + half) {
        if (cy > bestY) {
          bestY = cy;
          best = name;
        }
      }
    }
    return best;
  }

  override update(_time: number, delta: number): void {
    getWorld().timeSystem.tick(delta);
    this.panFromKeyboard(delta);
    for (const agent of this.agents.values()) {
      // y-sort walking agents (feet position decides paint order).
      agent.container.setDepth(agent.container.y + TILE_SIZE / 2);
      // Speech bubbles are top-level objects (nested containers do not render
      // in Phaser 4.1) — keep them glued above their walking agent.
      if (agent.speech) {
        agent.speech.setPosition(
          Math.round(agent.container.x),
          Math.round(agent.container.y - this.bubbleLift()),
        );
      }
    }
    this.restackLabels();
  }

  /** Arrow / WASD keyboard panning (stops any active follow). */
  private panFromKeyboard(delta: number): void {
    const c = this.cursors;
    const k = this.wasd;
    let dx = 0;
    let dy = 0;
    if (c?.left.isDown || k?.left.isDown) dx -= 1;
    if (c?.right.isDown || k?.right.isDown) dx += 1;
    if (c?.up.isDown || k?.up.isDown) dy -= 1;
    if (c?.down.isDown || k?.down.isDown) dy += 1;
    if (dx === 0 && dy === 0) return;
    if (this.following) {
      this.following = null;
      this.cameras.main.stopFollow();
    }
    const cam = this.cameras.main;
    const step = (CAMERA_PAN_SPEED * delta) / 1000 / cam.zoom;
    cam.setScroll(cam.scrollX + dx * step, cam.scrollY + dy * step);
  }

  /**
   * Rule-14 readability: keep name labels from overlapping when agents cluster.
   * Greedy top-down de-collision in world space — each label lifts above any
   * already-placed label it would collide with (generalizes the old 2-row
   * stagger to any number of stacked agents).
   */
  private restackLabels(): void {
    // Labels sit above their sprite. Two forces fight: agents cluster at the
    // map's top, where the HUD top bar (a separate scene drawn over the world)
    // would occlude a label; and clustered labels overlap each other. Resolve
    // both by clamping every label's top to just below the HUD band FIRST, then
    // de-colliding DOWNWARD (away from the band). De-colliding upward — the old
    // behavior — pushes labels back under the bar, so a top cluster collapses
    // into one overlapping row.
    const cam = this.cameras.main;
    // The camera viewport is inset below the HUD bar, so worldView.y is already
    // the top visible row; just keep labels from clipping at that edge.
    const ceilingTopY = cam.worldView.y + 2 / cam.zoom; // label-top floor
    const list = [...this.agents.values()].sort((a, b) => a.container.y - b.container.y);
    const placed: Rect[] = [];
    const lineH = LABEL_FONT_SIZE + 5;
    const base = this.labelLift();
    for (const a of list) {
      const w = (a.label.width || a.label.text.length * 7) + 4;
      const cx = a.container.x;
      // natural lift (above the sprite), but never let the label top breach the
      // HUD band — push it down to the floor if it would.
      const minLift = ceilingTopY - a.container.y + lineH;
      let lift = Math.max(base, minLift);
      for (let guard = 0; guard < 16; guard++) {
        const top = a.container.y + lift - lineH;
        const box: Rect = { x: cx - w / 2, y: top, w, h: lineH };
        const hit = placed.some(
          (p) =>
            !(box.x + box.w < p.x || box.x > p.x + p.w || box.y + box.h < p.y || box.y > p.y + p.h),
        );
        if (!hit) {
          placed.push(box);
          break;
        }
        lift += lineH; // stack downward, away from the HUD band
      }
      a.label.setY(Math.round(lift));
    }
  }

  // -- tile rendering --------------------------------------------------------

  private redrawAll(): void {
    const world = getWorld();
    this.tileGfx?.clear();
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        this.drawTile(x, y);
      }
    }
  }

  private drawTile(x: number, y: number): void {
    if (this.useAssets) {
      this.drawTileAssets(x, y);
    } else {
      this.drawTilePlaceholder(x, y);
    }
  }

  /** Static grass base under everything (water shores etc. are translucent). */
  private buildBaseLayer(): void {
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        this.add
          .image(x * TILE_SIZE, y * TILE_SIZE, "terrain", this.pick(GRASS_FRAMES, x, y))
          .setOrigin(0, 0)
          .setDepth(DEPTH_BASE);
      }
    }
  }

  /** Deterministic per-tile variant pick (stable across redraws). */
  private pick(frames: readonly number[], x: number, y: number): number {
    return frames[(x * 7 + y * 13) % frames.length];
  }

  private drawTileAssets(x: number, y: number): void {
    const world = getWorld();
    const tile = world.getTile(x, y);
    if (!tile) return;
    const key = `${x},${y}`;

    // Clear previous dynamic objects for this tile.
    this.overlays.get(key)?.destroy();
    this.overlays.delete(key);
    this.waterAnimTiles.delete(key);
    this.cropSprites.get(key)?.destroy();
    this.cropSprites.delete(key);

    const place = (
      texture: string,
      frame: number,
      depth = DEPTH_OVERLAY,
    ): Phaser.GameObjects.Image => {
      const img = this.add
        .image(x * TILE_SIZE, y * TILE_SIZE, texture, frame)
        .setOrigin(0, 0)
        .setDepth(depth);
      this.overlays.set(key, img);
      return img;
    };

    switch (tile.type) {
      case "grass":
        break; // base layer already shows grass
      case "path":
        // Cobblestone road (PathAndObjects) when present; else the v1 dirt path.
        if (this.textures.exists("paths"))
          place("paths", this.pick(COBBLE_PATH_FRAMES, x, y));
        else place("terrain", this.pick(PATH_FRAMES, x, y));
        break;
      case "water": {
        const isWater = (dx: number, dy: number): boolean =>
          world.getTile(x + dx, y + dy)?.type === "water";
        const frame = waterFrame(isWater);
        const img = place("water_tiles", frame);
        if (frame === WATER_FRAMES.ANIM[0]) {
          img.setFrame(WATER_FRAMES.ANIM[this.waterFrameIdx]);
          this.waterAnimTiles.set(key, img);
        }
        break;
      }
      case "soil": {
        const isField = (dx: number, dy: number): boolean => {
          const t = world.getTile(x + dx, y + dy)?.type;
          return t === "soil" || t === "tilled";
        };
        place("plowed_soil", soilFrame(isField));
        break;
      }
      case "tilled": {
        const img = place("plowed_soil", SOIL_FRAMES.TILLED);
        // Watered tilled soil reads visibly darker (moist earth).
        if (tile.crop?.watered) img.setTint(WATERED_SOIL_TINT);
        break;
      }
      case "building":
      case "bedTile":
      case "shopTile":
        break; // covered by the static facade dressing
      case "wall":
        // The impassable wall ring renders as the wooden farm fence.
        place("fence", fenceFrame(x, y, MAP_WIDTH, MAP_HEIGHT));
        break;
    }

    if (tile.crop) this.drawCropAssets(tile, x, y);
  }

  private drawCropAssets(tile: Tile, x: number, y: number): void {
    const crop = tile.crop!;
    const key = `${x},${y}`;
    const stripKind = this.cropStripKind(crop.kind);
    const cx = x * TILE_SIZE + TILE_SIZE / 2;
    const bottom = (y + 1) * TILE_SIZE;
    // crops paint just under an agent standing on the same tile
    const depth = bottom - 1;

    if (stripKind !== null) {
      const frame = cropStripFrame(crop.stage, CROPS[crop.kind].days, crop.ready);
      // Crop frames are 32x64 (tall) — anchor bottom so the plant sits on
      // the tile and overhangs the tile above.
      const img = this.add
        .image(cx, bottom, `${CROP_TEXTURE_PREFIX}${stripKind}`, frame)
        .setOrigin(0.5, 1)
        .setDepth(depth);
      this.cropSprites.set(key, img);
    } else {
      // Unknown kind with no strip/alias: placeholder marker (rule 15).
      const color = crop.ready ? CROP_READY_COLOR : CROP_COLORS[crop.kind] ?? 0xffffff;
      const rect = this.add
        .rectangle(cx, bottom - 8, 12, 12, color)
        .setDepth(depth);
      this.cropSprites.set(key, rect);
    }
  }

  /** Resolve a CropKind to a loaded strip texture kind, or null. */
  private cropStripKind(kind: string): string | null {
    const tryKinds = [kind, CROP_STRIP_ALIAS[kind]];
    for (const k of tryKinds) {
      if (k && this.textures.exists(`${CROP_TEXTURE_PREFIX}${k}`)) return k;
    }
    return null;
  }

  private tickWater(): void {
    this.waterFrameIdx = (this.waterFrameIdx + 1) % WATER_FRAMES.ANIM.length;
    const frame = WATER_FRAMES.ANIM[this.waterFrameIdx];
    for (const img of this.waterAnimTiles.values()) img.setFrame(frame);
  }

  // -- static dressing (assets mode, drawn once) -----------------------------

  /**
   * Brick facades over all 14 building footprints from map.ts (12 homesteads +
   * shop + tavern). Each entry in BUILDINGS carries its own doorX and kind, so
   * we never drift from the generated map. Shop/tavern get the light-wood door
   * (DOOR_B) and market crates; houses get the dark-wood door (DOOR_A).
   * Each kind gets a distinct roof/wall tint and a sign emoji (via buildingStyle)
   * so buildings are visually distinguishable even with the shared house.png art.
   */
  private dressBuildings(): void {
    const openRoof = this.textures.exists("interior");
    for (const b of BUILDINGS) {
      const isShop = b.kind === "shop";
      const isTavern = b.kind === "tavern";
      // Shop/tavern get a real hanging LPC sign (tankard / bread loaf); houses
      // keep the lightweight emoji sign from buildingStyle.
      const signFrame = isTavern
        ? SIGN_FRAMES.BEER
        : isShop
          ? SIGN_FRAMES.BREAD
          : undefined;
      if (openRoof) {
        // Smallville-style open-roof furnished room (agents walk in visibly).
        this.paintInterior(b, signFrame);
        continue;
      }
      // Degraded fallback: the v1 closed brick facade.
      const door: [number, number] =
        isShop || isTavern
          ? [HOUSE_FRAMES.DOOR_B_TOP, HOUSE_FRAMES.DOOR_B_BOT]
          : [HOUSE_FRAMES.DOOR_A_TOP, HOUSE_FRAMES.DOOR_A_BOT];
      const windowX = b.doorX === b.x0 ? b.x1 : b.x0;
      const style = buildingStyle(b.kind);
      this.paintFacade(b.x0, b.y0, b.x1, b.y1, {
        doorX: b.doorX,
        door,
        windowX,
        crateXs: isShop ? [b.x0, b.x1] : undefined,
        tint: style.tint,
        sign: style.sign,
        signFrame,
      });
    }
  }

  /**
   * Open-roof furnished interior (Smallville cutaway): a tiled floor over the
   * whole footprint, a back-wall strip along the top, kind-specific furniture,
   * and the hanging/emoji sign above. No opaque roof, so agents standing on the
   * bed/door tiles read as being *inside* the room.
   */
  private paintInterior(b: (typeof BUILDINGS)[number], signFrame?: number): void {
    const { x0, y0, x1, y1, kind } = b;
    const hasFurn = this.textures.exists("furniture_wood");
    const put = (
      x: number,
      y: number,
      texture: string,
      frame: number,
      depth: number,
    ): void => {
      this.add
        .image(x * TILE_SIZE, y * TILE_SIZE, texture, frame)
        .setOrigin(0, 0)
        .setDepth(depth);
    };

    // Floor across the whole footprint, then the back wall along the top row.
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        put(x, y, "interior", INTERIOR_FRAMES.FLOOR, DEPTH_FACADE);
    for (let x = x0; x <= x1; x++)
      put(x, y0, "interior", INTERIOR_FRAMES.WALL[(x - x0) % INTERIOR_FRAMES.WALL.length], DEPTH_FACADE);

    // Kind-specific furnishing (props sit above the floor; agents y-sort over them).
    if (kind === "house") {
      if (hasFurn) {
        put(x0, y0 + 1, "furniture_wood", FURNITURE_FRAMES.BED_HEAD_L, DEPTH_PROP);
        put(x0 + 1, y0 + 1, "furniture_wood", FURNITURE_FRAMES.BED_HEAD_R, DEPTH_PROP);
        put(x0, y1, "furniture_wood", FURNITURE_FRAMES.BED_FOOT_L, DEPTH_PROP);
        put(x0 + 1, y1, "furniture_wood", FURNITURE_FRAMES.BED_FOOT_R, DEPTH_PROP);
      }
      put(x1, y0 + 1, "interior", INTERIOR_FRAMES.SHELF, DEPTH_PROP);
    } else if (kind === "shop") {
      put(x0, y0 + 1, "interior", INTERIOR_FRAMES.SHELF, DEPTH_PROP);
      put(x1, y0 + 1, "interior", INTERIOR_FRAMES.CABINET, DEPTH_PROP);
      // Produce crates flanking the storefront (kept from the old facade look).
      put(x0, y1, "farming", CRATE_FRAMES[0], DEPTH_PROP);
      put(x1, y1, "farming", CRATE_FRAMES[1], DEPTH_PROP);
    } else if (kind === "tavern") {
      if (hasFurn) put(x0 + 1, y0 + 1, "furniture_wood", FURNITURE_FRAMES.TABLE_ROUND, DEPTH_PROP);
      put(x0, y1, "interior", INTERIOR_FRAMES.BARREL, DEPTH_PROP);
      put(x1, y1, "interior", INTERIOR_FRAMES.BARREL, DEPTH_PROP);
    }

    // Sign above the room: real hanging sign for shop/tavern, emoji for houses.
    const midX = ((x0 + x1) / 2 + 0.5) * TILE_SIZE;
    if (signFrame != null && this.textures.exists("decorations")) {
      this.add
        .image(midX, y0 * TILE_SIZE, "decorations", signFrame)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_PROP + 1);
    } else {
      const sign = buildingStyle(kind).sign;
      if (sign)
        this.add
          .text(midX, y0 * TILE_SIZE - 4, sign, {
            fontSize: "16px",
            fontFamily: "ui-monospace, Menlo, monospace",
            stroke: "#000000",
            strokeThickness: 2,
          })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH_PROP + 1);
    }
  }

  private paintFacade(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    opts: {
      doorX: number;
      door: [number, number];
      windowX: number;
      crateXs?: number[];
      /** 0xRRGGBB tint applied to all facade tiles (0xffffff = no tint) */
      tint?: number;
      /** Emoji/sign placed centred above the roof, below speech bubbles */
      sign?: string;
      /** decorations-sheet hanging-sign frame; overrides the emoji sign when set */
      signFrame?: number;
    },
  ): void {
    const tint = opts.tint ?? 0xffffff;
    const put = (x: number, y: number, frame: number, depth: number): Phaser.GameObjects.Image => {
      return this.add
        .image(x * TILE_SIZE, y * TILE_SIZE, "house", frame)
        .setOrigin(0, 0)
        .setDepth(depth)
        .setTint(tint);
    };
    for (let y = y0; y <= y1; y++) {
      const row =
        y === y0
          ? [HOUSE_FRAMES.TOP_L, HOUSE_FRAMES.TOP_M, HOUSE_FRAMES.TOP_R]
          : y === y1
            ? [HOUSE_FRAMES.BASE_L, HOUSE_FRAMES.BASE_M, HOUSE_FRAMES.BASE_R]
            : [HOUSE_FRAMES.MID_L, HOUSE_FRAMES.MID_M, HOUSE_FRAMES.MID_R];
      for (let x = x0; x <= x1; x++) {
        const frame = x === x0 ? row[0] : x === x1 ? row[2] : row[1];
        put(x, y, frame, DEPTH_FACADE);
      }
    }
    // Door (32x64) over the entrance column; window (32x64) beside it.
    put(opts.doorX, y1 - 1, opts.door[0], DEPTH_PROP);
    put(opts.doorX, y1, opts.door[1], DEPTH_PROP);
    put(opts.windowX, y1 - 1, HOUSE_FRAMES.WIN_TOP, DEPTH_PROP);
    put(opts.windowX, y1, HOUSE_FRAMES.WIN_BOT, DEPTH_PROP);
    // Market crates on impassable building tiles flanking the shop door.
    for (const [i, cx] of (opts.crateXs ?? []).entries()) {
      this.add
        .image(cx * TILE_SIZE, y1 * TILE_SIZE, "farming", CRATE_FRAMES[i % CRATE_FRAMES.length])
        .setOrigin(0, 0)
        .setDepth(DEPTH_PROP);
    }
    // Signage centred above the roof (y0 row), depth between props and bubbles.
    const midX = ((x0 + x1) / 2 + 0.5) * TILE_SIZE; // pixel centre of facade
    if (opts.signFrame != null && this.textures.exists("decorations")) {
      // Real LPC hanging sign, bottom-anchored just above the roofline.
      this.add
        .image(midX, y0 * TILE_SIZE, "decorations", opts.signFrame)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_PROP + 1);
    } else if (opts.sign) {
      this.add
        .text(midX, y0 * TILE_SIZE - 4, opts.sign, {
          fontSize: "16px",
          fontFamily: "ui-monospace, Menlo, monospace",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_PROP + 1);
    }
  }

  /** A few fruit trees along the bottom fence for life. */
  private dressTrees(): void {
    if (!this.textures.exists("fruit_trees")) return;
    for (const t of TREE_SPOTS) {
      this.add
        .image(
          t.x * TILE_SIZE + TILE_SIZE / 2,
          (t.y + 1) * TILE_SIZE - 2,
          "fruit_trees",
          TREE_FRAMES.includes(t.frame) ? t.frame : TREE_FRAMES[0],
        )
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_OVERHEAD);
    }
  }

  /**
   * v3 — Draw each world object (well, notice board, bench). In assets mode
   * the well and notice board use real LPC decoration sprites; the bench (no
   * dedicated sprite yet) and the whole placeholder path fall back to a labeled
   * colored-rect marker.
   */
  private dressWorldObjects(): void {
    const hasDeco = this.useAssets && this.textures.exists("decorations");
    const OBJECT_COLORS: Record<string, number> = {
      well:         0x4488cc, // blue — water
      notice_board: 0xcc8833, // amber — parchment
      bench:        0x886644, // brown — wood
    };
    const OBJECT_LABELS: Record<string, string> = {
      well:         "🪣",
      notice_board: "📋",
      bench:        "🪑",
    };

    // Place a decorations-sheet tile at a map cell (top-left origin).
    const deco = (tx: number, ty: number, frame: number, depth = DEPTH_PROP): void => {
      this.add
        .image(tx * TILE_SIZE, ty * TILE_SIZE, "decorations", frame)
        .setOrigin(0, 0)
        .setDepth(depth);
    };

    // Fallback marker: rounded rect + emoji (placeholder mode, or props without art).
    const marker = (obj: (typeof WORLD_OBJECTS)[number]): void => {
      const px = obj.pos.x * TILE_SIZE;
      const py = obj.pos.y * TILE_SIZE;
      const gfx = this.add.graphics();
      gfx.fillStyle(OBJECT_COLORS[obj.kind] ?? 0xffffff, 0.85);
      gfx.fillRoundedRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8, 4);
      gfx.lineStyle(1, 0x000000, 0.5);
      gfx.strokeRoundedRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8, 4);
      gfx.setDepth(DEPTH_PROP + 1);
      this.add
        .text(px + TILE_SIZE / 2, py + TILE_SIZE / 2, OBJECT_LABELS[obj.kind] ?? "⚙", {
          fontSize: "14px",
          align: "center",
        })
        .setOrigin(0.5, 0.5)
        .setDepth(DEPTH_PROP + 2);
    };

    for (const obj of WORLD_OBJECTS) {
      const { x, y } = obj.pos;
      if (hasDeco && obj.kind === "well") {
        // 2×2 stone well anchored bottom-right on the object tile; it rises one
        // tile up onto the grass strip and never overlaps the flanking buildings.
        deco(x - 1, y - 1, WELL_FRAMES.RIM_L);
        deco(x,     y - 1, WELL_FRAMES.RIM_R);
        deco(x - 1, y,     WELL_FRAMES.BODY_L);
        deco(x,     y,     WELL_FRAMES.BODY_R);
      } else if (hasDeco && obj.kind === "notice_board") {
        deco(x, y, SIGN_FRAMES.BOARD);
        this.add
          .text(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE - 2, OBJECT_LABELS.notice_board, {
            fontSize: "12px",
          })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH_PROP + 2);
      } else {
        marker(obj);
      }
    }
  }

  // -- placeholder tile rendering (v1 fallback, unchanged behavior) ----------

  /** Tiles are opaque rects, so drawing over a tile fully replaces it. */
  private drawTilePlaceholder(x: number, y: number): void {
    const tile = getWorld().getTile(x, y);
    if (!tile || !this.tileGfx) return;
    const px = x * TILE_SIZE;
    const py = y * TILE_SIZE;
    this.tileGfx.fillStyle(TILE_COLORS[tile.type], 1);
    this.tileGfx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Faint grid line for legibility.
    this.tileGfx.lineStyle(1, 0x000000, 0.08);
    this.tileGfx.strokeRect(px + 0.5, py + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
    if (tile.crop) this.drawCropPlaceholder(tile, px, py);
  }

  private drawCropPlaceholder(tile: Tile, px: number, py: number): void {
    const crop = tile.crop!;
    if (!this.tileGfx) return;
    if (crop.watered) {
      this.tileGfx.fillStyle(WATERED_TINT, 0.45);
      this.tileGfx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    }
    const days = CROPS[crop.kind].days;
    const t = Math.min(crop.stage / days, 1);
    const radius = crop.ready ? 8 : 3 + t * 5;
    const color = crop.ready
      ? CROP_READY_COLOR
      : CROP_COLORS[crop.kind] ?? 0xffffff;
    this.tileGfx.fillStyle(color, 1);
    this.tileGfx.fillCircle(px + TILE_SIZE / 2, py + TILE_SIZE / 2, radius);
  }

  // -- characters ------------------------------------------------------------

  private characters(): CharacterAsset[] {
    return this.manifest?.characters ?? [];
  }

  private createCharacterAnims(): void {
    for (const c of this.characters()) {
      if (!this.textures.exists(c.key)) continue;
      const rows: [Dir, number][] = [
        ["up", c.rows.walkUp],
        ["left", c.rows.walkLeft],
        ["down", c.rows.walkDown],
        ["right", c.rows.walkRight],
      ];
      for (const [dir, row] of rows) {
        const animKey = `${c.key}-walk-${dir}`;
        if (this.anims.exists(animKey)) continue;
        this.anims.create({
          key: animKey,
          // LPC walk row: frame 0 is the idle stance, 1-8 the walk cycle.
          frames: this.anims.generateFrameNumbers(c.key, {
            start: row * c.framesPerRow + 1,
            end: row * c.framesPerRow + c.framesPerRow - 1,
          }),
          frameRate: 10,
          repeat: -1,
        });
      }
    }
  }

  private idleFrame(char: CharacterAsset, dir: Dir): number {
    const row =
      dir === "up"
        ? char.rows.walkUp
        : dir === "left"
          ? char.rows.walkLeft
          : dir === "right"
            ? char.rows.walkRight
            : char.rows.walkDown;
    return row * char.framesPerRow;
  }

  private charByKey(key: string | null): CharacterAsset | null {
    return this.characters().find((c) => c.key === key) ?? null;
  }

  /**
   * Stable round-robin character binding: sort all registered agent names,
   * then name i gets manifest character i % N. Re-run on every registration
   * so late registrations cannot scramble earlier bindings non-deterministically.
   * Also applies the label stagger (rule 14 readability fix: adjacent labels
   * alternate height so they never overlap each other).
   */
  private rebindAgentVisuals(): void {
    const sorted = [...this.agentNames].sort();
    const chars = this.characters();
    for (const [i, name] of sorted.entries()) {
      const agent = this.agents.get(name);
      if (!agent) continue;
      agent.label.setY(Math.round(this.labelLift())); // base; restackLabels() de-collides per frame
      if (agent.sprite && chars.length > 0) {
        const c = chars[i % chars.length];
        if (agent.charKey !== c.key) {
          agent.charKey = c.key;
          agent.sprite.stop();
          agent.sprite.setTexture(c.key, this.idleFrame(c, agent.facing));
        }
      }
    }
  }

  /** label baseline above the sprite's head (negative container offset) */
  private labelLift(): number {
    return this.useAssets ? -(TILE_SIZE + 14) : -(TILE_SIZE * 0.75);
  }

  /** speech bubble / emote anchor height above the container center */
  private bubbleLift(): number {
    return this.useAssets ? TILE_SIZE * 1.9 : TILE_SIZE * 1.4;
  }

  // -- RenderApi --------------------------------------------------------------

  /** Idempotent: re-registering repositions (and recolors, in fallback). */
  registerAgentSprite(name: string, color: number, pos: Vec2): void {
    const existing = this.agents.get(name);
    if (existing) {
      existing.container.setPosition(...this.tileCenter(pos));
      existing.tilePos = { ...pos };
      if (existing.circle) {
        existing.circle.clear();
        this.paintAgentCircle(existing.circle, color);
      }
      return;
    }

    let sprite: Phaser.GameObjects.Sprite | null = null;
    let circle: Phaser.GameObjects.Graphics | null = null;
    if (this.useAssets && this.characters().length > 0) {
      const c = this.characters()[0];
      // Feet a hair above the tile's bottom edge; 64x64 LPC frame towers
      // over the 32px tile, which is the wanted look.
      sprite = this.add
        .sprite(0, TILE_SIZE / 2 - 1, c.key, this.idleFrame(c, "down"))
        .setOrigin(0.5, 1);
    } else {
      circle = this.add.graphics();
      this.paintAgentCircle(circle, color);
    }

    const label = this.add
      .text(0, Math.round(this.labelLift()), name, {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: `${LABEL_FONT_SIZE}px`,
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    // Smallville "pronunciatio": persistent activity emoji pinned just above
    // the name label, below speech bubbles. Starts blank until first action.
    const activityLabel = this.add
      .text(0, Math.round(this.labelLift()) - LABEL_FONT_SIZE - 2, "", {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "14px",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH_PROP);
    const [cx, cy] = this.tileCenter(pos);
    const container = this.add.container(cx, cy, [
      ...(sprite ? [sprite] : []),
      ...(circle ? [circle] : []),
      label,
      activityLabel,
    ]);
    container.setDepth(cy + TILE_SIZE / 2);
    this.agents.set(name, {
      container,
      sprite,
      circle,
      label,
      activityLabel,
      charKey: null,
      facing: "down",
      tilePos: { ...pos },
      speech: null,
      speechTimer: null,
    });
    this.agentNames.push(name);
    this.rebindAgentVisuals();
  }

  /**
   * Tween toward the tile center (~200ms/tile divided by speed) playing the
   * directional LPC walk animation inferred from the movement vector;
   * idles (stop on the row's standing frame) on arrival.
   */
  setAgentPos(name: string, pos: Vec2): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    const [cx, cy] = this.tileCenter(pos);
    const dx = pos.x - agent.tilePos.x;
    const dy = pos.y - agent.tilePos.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    agent.tilePos = { ...pos };
    this.tweens.killTweensOf(agent.container);
    if (dist === 0) {
      agent.container.setPosition(cx, cy);
      return;
    }

    const dir: Dir =
      Math.abs(dx) >= Math.abs(dy)
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "down"
          : "up";
    agent.facing = dir;
    const char = this.charByKey(agent.charKey);
    if (agent.sprite && char) {
      agent.sprite.play(`${char.key}-walk-${dir}`, true);
    }

    const speed = getWorld().timeSystem.getSpeed();
    const duration = Math.max(40, (dist * WALK_MS_PER_TILE) / speed);
    this.tweens.add({
      targets: agent.container,
      x: cx,
      y: cy,
      duration,
      ease: "Linear",
      onComplete: () => {
        if (agent.sprite && char) {
          agent.sprite.stop();
          agent.sprite.setFrame(this.idleFrame(char, dir));
        }
      },
    });
  }

  /**
   * Transient speech bubble (~4s), truncated to ~60 chars; the border is
   * tinted by the speaker's emotion (v2).
   */
  showSpeech(name: string, text: string, emotion: Emotion = "neutral"): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    agent.speechTimer?.remove();
    agent.speech?.destroy();

    const shown =
      text.length > SPEECH_MAX_CHARS
        ? `${text.slice(0, SPEECH_MAX_CHARS - 1)}…`
        : text;
    const label = this.add
      .text(0, 0, shown, {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: `${SPEECH_FONT_SIZE}px`,
        color: "#101014",
        wordWrap: { width: 230 },
      })
      .setOrigin(0.5, 0.5);
    const bounds = label.getBounds();
    const pad = 4;
    const bg = this.add.graphics();
    bg.fillStyle(0xffffff, 0.94);
    bg.fillRoundedRect(
      -bounds.width / 2 - pad,
      -bounds.height / 2 - pad,
      bounds.width + pad * 2,
      bounds.height + pad * 2,
      4,
    );
    bg.lineStyle(2, EMOTION_STYLE[emotion]?.color ?? EMOTION_STYLE.neutral.color, 1);
    bg.strokeRoundedRect(
      -bounds.width / 2 - pad,
      -bounds.height / 2 - pad,
      bounds.width + pad * 2,
      bounds.height + pad * 2,
      4,
    );
    const bubble = this.add.container(
      Math.round(agent.container.x),
      Math.round(agent.container.y - this.bubbleLift()),
      [bg, label],
    );
    bubble.setDepth(DEPTH_BUBBLE);
    agent.speech = bubble;
    agent.speechTimer = this.time.delayedCall(SPEECH_DURATION_MS, () => {
      bubble.destroy();
      if (agent.speech === bubble) agent.speech = null;
      agent.speechTimer = null;
    });
  }

  /**
   * Smallville "pronunciatio": update the persistent activity emoji for an
   * agent. Called by AgentRuntime after each decision cycle with the chosen
   * ActionType (and optional emotion for EMOTE actions). The emoji is rendered
   * as a small text object pinned above the name label, below speech bubbles.
   */
  setActivityEmoji(name: string, action: string, emotion?: string): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    // activityEmoji is a pure function — import is at top of file.
    const emoji = activityEmoji(
      action as Parameters<typeof activityEmoji>[0],
      emotion as Parameters<typeof activityEmoji>[1],
    );
    agent.activityLabel.setText(emoji);
  }

  /** v2 — transient ~2s emote symbol floating up above the sprite. */
  playEmote(name: string, emotion: Emotion): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    const style = EMOTION_STYLE[emotion] ?? EMOTION_STYLE.neutral;
    const txt = this.add
      .text(
        Math.round(agent.container.x),
        Math.round(agent.container.y - this.bubbleLift() + 6),
        style.symbol,
        {
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: "16px",
          color: style.cssColor,
          stroke: "#000000",
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5, 1)
      .setDepth(DEPTH_BUBBLE);
    this.tweens.add({
      targets: txt,
      y: txt.y - 14,
      alpha: 0,
      duration: EMOTE_DURATION_MS,
      ease: "Sine.easeOut",
      onComplete: () => txt.destroy(),
    });
  }

  // -- helpers ----------------------------------------------------------------

  private tileCenter(pos: Vec2): [number, number] {
    return [pos.x * TILE_SIZE + TILE_SIZE / 2, pos.y * TILE_SIZE + TILE_SIZE / 2];
  }

  private paintAgentCircle(
    gfx: Phaser.GameObjects.Graphics,
    color: number,
  ): void {
    gfx.fillStyle(color, 1);
    gfx.fillCircle(0, 0, TILE_SIZE * 0.4);
    gfx.lineStyle(1, 0x000000, 0.6);
    gfx.strokeCircle(0, 0, TILE_SIZE * 0.4);
  }
}
