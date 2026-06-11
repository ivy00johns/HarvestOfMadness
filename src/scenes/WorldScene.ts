/**
 * WorldScene — owns ALL drawing (zero-asset fallback: colored rects via
 * Graphics, agents as labeled circles). Implements the contract RenderApi;
 * other modules reach it via src/world/render.ts (set in create()).
 */
import Phaser from "phaser";
import type { RenderApi, Tile, Vec2 } from "@contracts/types";
import { CROPS, TILE_SIZE } from "@contracts/types";
import {
  CROP_COLORS,
  CROP_READY_COLOR,
  SPEECH_DURATION_MS,
  SPEECH_MAX_CHARS,
  TILE_COLORS,
  WALK_MS_PER_TILE,
  WATERED_TINT,
} from "../config";
import { getWorld } from "../world/instance";
import { setRenderApi } from "../world/render";
import { runScriptedDemo } from "../world/scriptedDemo";

interface AgentSprite {
  container: Phaser.GameObjects.Container;
  tilePos: Vec2;
  speech: Phaser.GameObjects.Container | null;
  speechTimer: Phaser.Time.TimerEvent | null;
}

export class WorldScene extends Phaser.Scene implements RenderApi {
  private tileGfx!: Phaser.GameObjects.Graphics;
  private readonly agents = new Map<string, AgentSprite>();
  private unsubscribeWorld: (() => void) | null = null;

  constructor() {
    super("world");
  }

  create(): void {
    const world = getWorld();

    this.tileGfx = this.add.graphics();
    this.tileGfx.setDepth(0);
    this.redrawAll();

    this.unsubscribeWorld = world.onChange((tiles) => {
      if (tiles === null) {
        this.redrawAll();
      } else {
        for (const p of tiles) this.drawTile(p.x, p.y);
      }
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribeWorld?.();
      setRenderApi(null);
    });

    // Expose RenderApi to the agent pipeline (W2).
    setRenderApi(this);

    if (import.meta.env.VITE_SCRIPTED_DEMO === "1") {
      void runScriptedDemo(world);
    }
  }

  override update(_time: number, delta: number): void {
    getWorld().timeSystem.tick(delta);
    // Speech bubbles are top-level objects (nested containers do not render
    // in Phaser 4.1) — keep them glued above their walking agent.
    for (const agent of this.agents.values()) {
      if (agent.speech) {
        agent.speech.setPosition(
          agent.container.x,
          agent.container.y - TILE_SIZE * 1.4,
        );
      }
    }
  }

  // -- tile rendering ------------------------------------------------------

  private redrawAll(): void {
    const world = getWorld();
    this.tileGfx.clear();
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        this.drawTile(x, y);
      }
    }
  }

  /** Tiles are opaque rects, so drawing over a tile fully replaces it. */
  private drawTile(x: number, y: number): void {
    const tile = getWorld().getTile(x, y);
    if (!tile) return;
    const px = x * TILE_SIZE;
    const py = y * TILE_SIZE;
    this.tileGfx.fillStyle(TILE_COLORS[tile.type], 1);
    this.tileGfx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Faint grid line for legibility.
    this.tileGfx.lineStyle(1, 0x000000, 0.08);
    this.tileGfx.strokeRect(px + 0.5, py + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
    if (tile.crop) this.drawCrop(tile, px, py);
  }

  private drawCrop(tile: Tile, px: number, py: number): void {
    const crop = tile.crop!;
    if (crop.watered) {
      this.tileGfx.fillStyle(WATERED_TINT, 0.45);
      this.tileGfx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    }
    const days = CROPS[crop.kind].days;
    const t = Math.min(crop.stage / days, 1);
    const radius = crop.ready ? 5.5 : 1.5 + t * 3.5;
    const color = crop.ready
      ? CROP_READY_COLOR
      : CROP_COLORS[crop.kind] ?? 0xffffff;
    this.tileGfx.fillStyle(color, 1);
    this.tileGfx.fillCircle(px + TILE_SIZE / 2, py + TILE_SIZE / 2, radius);
  }

  // -- RenderApi -----------------------------------------------------------

  /** Idempotent: re-registering recolors/repositions the existing sprite. */
  registerAgentSprite(name: string, color: number, pos: Vec2): void {
    const existing = this.agents.get(name);
    if (existing) {
      existing.container.setPosition(...this.tileCenter(pos));
      existing.tilePos = { ...pos };
      const circle = existing.container.getAt(0) as Phaser.GameObjects.Graphics;
      circle.clear();
      this.paintAgentCircle(circle, color);
      return;
    }

    const circle = this.add.graphics();
    this.paintAgentCircle(circle, color);
    const label = this.add
      .text(0, -TILE_SIZE * 0.75, name, {
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: "7px",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1);
    const [cx, cy] = this.tileCenter(pos);
    const container = this.add.container(cx, cy, [circle, label]);
    container.setDepth(10);
    this.agents.set(name, {
      container,
      tilePos: { ...pos },
      speech: null,
      speechTimer: null,
    });
  }

  /** Tween toward the tile center, ~200ms per tile divided by speed. */
  setAgentPos(name: string, pos: Vec2): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    const [cx, cy] = this.tileCenter(pos);
    const dist =
      Math.abs(pos.x - agent.tilePos.x) + Math.abs(pos.y - agent.tilePos.y);
    agent.tilePos = { ...pos };
    this.tweens.killTweensOf(agent.container);
    const speed = getWorld().timeSystem.getSpeed();
    const duration = Math.max(40, (dist * WALK_MS_PER_TILE) / speed);
    if (dist === 0) {
      agent.container.setPosition(cx, cy);
      return;
    }
    this.tweens.add({
      targets: agent.container,
      x: cx,
      y: cy,
      duration,
      ease: "Linear",
    });
  }

  /** Transient speech bubble (~4s), truncated to ~60 chars. */
  showSpeech(name: string, text: string): void {
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
        fontSize: "7px",
        color: "#101014",
        wordWrap: { width: 110 },
      })
      .setOrigin(0.5, 0.5);
    const bounds = label.getBounds();
    const pad = 3;
    const bg = this.add.graphics();
    bg.fillStyle(0xffffff, 0.92);
    bg.fillRoundedRect(
      -bounds.width / 2 - pad,
      -bounds.height / 2 - pad,
      bounds.width + pad * 2,
      bounds.height + pad * 2,
      3,
    );
    const bubble = this.add.container(
      agent.container.x,
      agent.container.y - TILE_SIZE * 1.4,
      [bg, label],
    );
    bubble.setDepth(20);
    agent.speech = bubble;
    agent.speechTimer = this.time.delayedCall(SPEECH_DURATION_MS, () => {
      bubble.destroy();
      if (agent.speech === bubble) agent.speech = null;
      agent.speechTimer = null;
    });
  }

  // -- helpers ---------------------------------------------------------------

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
