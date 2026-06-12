/**
 * UIScene — spectator HUD (§8), pure Phaser (canvas-rendered, DOM-free).
 *
 * Runs as a parallel scene over WorldScene (auto-started via `active: true`;
 * last in main.ts' scene array, so it renders on top). Layout in the logical
 * 384x288 space:
 *   - top bar: controls (pause/step/speed) left, Day/phase/speed + badges right
 *   - agent cards: right column, click a card to open its decision trace panel
 *   - event log: bottom-left, newest ~12 lines colored by kind
 *
 * Update discipline (contract §8): cards re-render on EventBus events with a
 * ~150ms trailing throttle plus a 500ms timer for live energy/FSM/clock —
 * NEVER per-frame text rebuilds. Phaser 4.1 gotcha respected: no nested
 * containers anywhere; every object is positioned absolutely.
 */
import Phaser from "phaser";
import type { AgentCardModel, DecisionTraceEntry, WorldEvent } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "@contracts/types";
import {
  EventLog,
  eventColor,
  formatEventLine,
  toCssColor,
} from "../obs/EventLog";
import {
  buildAgentCard,
  formatTraceEntry,
  formatTraceSummary,
} from "../obs/Inspector";
import type { ObsConnection } from "../obs/wiring";
import { connectObservability } from "../obs/wiring";
import { startAgents } from "../agents/bootstrap";
import { getTimeSystem } from "../world/instance";

// -- layout constants (logical pixels) ---------------------------------------

const W = MAP_WIDTH * TILE_SIZE; // 384
const H = MAP_HEIGHT * TILE_SIZE; // 288
const FONT = "ui-monospace, Menlo, monospace";

const TOPBAR_H = 14;
const CARD_W = 116;
const CARD_X = W - CARD_W - 2;
const CARD_TOP = TOPBAR_H + 2;

const LOG_LINES = 12;
const LOG_LINE_H = 8;
const LOG_W = 250;
const LOG_H = LOG_LINES * LOG_LINE_H + 8;
const LOG_Y = H - LOG_H - 2;

const PANEL_X = 2;
const PANEL_Y = TOPBAR_H + 2;
const PANEL_W = 258;
const PANEL_H = LOG_Y - PANEL_Y - 4;
const PANEL_VISIBLE_TRACE = 5;

const DEPTH_HUD = 100;
const DEPTH_HUD_TEXT = 101;
const DEPTH_PANEL = 200;

const REFRESH_THROTTLE_MS = 150;
const LIVE_TIMER_MS = 500;

const FSM_COLORS: Record<string, string> = {
  IDLE: "#8a8f98", // grey
  THINKING: "#e0af68", // yellow
  EXECUTING: "#9ece6a", // green
};

const PHASE_ICON: Record<string, string> = {
  morning: "☀", // sun
  afternoon: "☼", // bright sun
  evening: "☾", // moon
  night: "✦", // star
};

const SPEEDS = [0.5, 1, 2, 4] as const;

interface CardUi {
  bg: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  fsm: Phaser.GameObjects.Text;
  persona: Phaser.GameObjects.Text | null;
  gold: Phaser.GameObjects.Text;
  energyBg: Phaser.GameObjects.Rectangle;
  energyFill: Phaser.GameObjects.Rectangle;
  energyText: Phaser.GameObjects.Text;
  goal: Phaser.GameObjects.Text;
  thought: Phaser.GameObjects.Text;
  action: Phaser.GameObjects.Text;
  meta: Phaser.GameObjects.Text;
}

export class UIScene extends Phaser.Scene {
  private conn: ObsConnection | null = null;
  private readonly eventLog = new EventLog();
  private readonly unsubscribers: Array<() => void> = [];
  private destroyed = false;

  private budgetReached = false;
  private refreshPending = false;

  // top bar
  private statusText!: Phaser.GameObjects.Text;
  private pausedBadge!: Phaser.GameObjects.Text;
  private budgetBadge!: Phaser.GameObjects.Text;
  private pauseBtn!: Phaser.GameObjects.Text;
  private speedBtns = new Map<number, Phaser.GameObjects.Text>();

  // event log
  private logTexts: Phaser.GameObjects.Text[] = [];

  // agent cards
  private cards = new Map<string, CardUi>();
  private cardLayoutKey = "";

  // trace panel
  private selectedAgent: string | null = null;
  private readonly expandedTurnIds = new Set<string>();
  private traceScroll = 0;
  private panelObjects: Phaser.GameObjects.GameObject[] = [];
  private panelEntries: Phaser.GameObjects.Text[] = [];
  private panelContentH = 0;

  constructor() {
    super({ key: "ui", active: true });
  }

  create(): void {
    this.scene.bringToTop();
    this.buildTopBar();
    this.buildEventLogChrome();
    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (
        pointer: Phaser.Input.Pointer,
        _objs: unknown,
        _dx: number,
        dy: number,
      ) => this.onWheel(pointer, dy),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.destroyed = true;
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers.length = 0;
    });
    // bootstrap.ts delegates the start call to the main.ts-carve-out owner
    // (us); it self-defers until WorldScene publishes its RenderApi.
    startAgents();
    this.connect();
  }

  // -- wiring -----------------------------------------------------------------

  private connect(): void {
    const conn = connectObservability();
    this.conn = conn;

    this.unsubscribers.push(this.eventLog.attach(conn.bus));
    this.unsubscribers.push(conn.bus.on((e) => this.onBusEvent(e)));
    // budget_reached badge is sticky — honor events emitted before we attached
    if (this.eventLog.list().some((e) => e.kind === "budget_reached")) {
      this.budgetReached = true;
    }
    this.unsubscribers.push(getTimeSystem().onChange(() => this.refreshTopBar()));
    this.time.addEvent({
      delay: LIVE_TIMER_MS,
      loop: true,
      callback: () => this.refreshLive(),
    });
    this.refreshAll();
  }

  private onBusEvent(e: WorldEvent): void {
    if (e.kind === "budget_reached") this.budgetReached = true;
    this.markDirty();
  }

  /** Trailing ~150ms throttle: many events coalesce into one re-render. */
  private markDirty(): void {
    if (this.refreshPending || this.destroyed) return;
    this.refreshPending = true;
    this.time.delayedCall(REFRESH_THROTTLE_MS, () => {
      this.refreshPending = false;
      this.refreshAll();
    });
  }

  private refreshAll(): void {
    if (this.destroyed) return;
    this.refreshTopBar();
    this.renderEventLog();
    this.renderCards();
    if (this.selectedAgent) this.rebuildPanelEntries();
  }

  /** 500ms live tick: clock, energy bars, FSM chips — no full text rebuilds. */
  private refreshLive(): void {
    if (this.destroyed) return;
    this.refreshTopBar();
    const agents = this.conn?.controls.agents() ?? [];
    for (const agent of agents) {
      const ui = this.cards.get(agent.name);
      if (!ui) continue;
      this.updateEnergy(ui, agent.energy);
      ui.fsm.setText(agent.fsm).setColor(FSM_COLORS[agent.fsm] ?? "#8a8f98");
    }
  }

  // -- top bar: controls + status ----------------------------------------------

  private buildTopBar(): void {
    this.add
      .rectangle(0, 0, W, TOPBAR_H, 0x101218, 0.88)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);

    let x = 2;
    const place = (label: string, onClick: () => void): Phaser.GameObjects.Text => {
      const btn = this.makeButton(x, 2, label, onClick);
      x = btn.x + btn.width + 3;
      return btn;
    };

    this.pauseBtn = place("⏸", () => this.togglePause());
    place("⏭", () => {
      this.conn?.controls.step();
      this.refreshTopBar();
    });
    for (const speed of SPEEDS) {
      const label = speed === 0.5 ? "½" : String(speed);
      this.speedBtns.set(
        speed,
        place(label, () => {
          this.conn?.controls.setSpeed(speed);
          this.refreshTopBar();
        }),
      );
    }

    this.statusText = this.add
      .text(W - 3, 3, "", { fontFamily: FONT, fontSize: "7px", color: "#e6e6e6" })
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT);
    this.pausedBadge = this.add
      .text(0, 3, "PAUSED", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#ff5555",
        backgroundColor: "#3a1418",
        padding: { x: 2, y: 0 },
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    this.budgetBadge = this.add
      .text(0, 3, "BUDGET REACHED", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#ffb86c",
        backgroundColor: "#3a2a14",
        padding: { x: 2, y: 0 },
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);

    this.refreshTopBar();
  }

  private makeButton(
    x: number,
    y: number,
    label: string,
    onClick: () => void,
  ): Phaser.GameObjects.Text {
    const btn = this.add
      .text(x, y, label, {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#e6e6e6",
        backgroundColor: "#2a2f3a",
        padding: { x: 3, y: 1 },
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setInteractive({ useHandCursor: true });
    btn.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, onClick);
    return btn;
  }

  private togglePause(): void {
    const controls = this.conn?.controls;
    if (!controls) return;
    if (controls.isPaused()) controls.resume();
    else controls.pause();
    this.refreshTopBar();
  }

  private refreshTopBar(): void {
    if (this.destroyed) return;
    const time = getTimeSystem();
    const t = time.state();
    const speed = time.getSpeed();
    const icon = PHASE_ICON[t.phase] ?? "";
    this.statusText.setText(`Day ${t.day} ${icon} ${t.phase} · x${speed}`);

    const paused = this.conn?.controls.isPaused() ?? time.isPaused();
    this.pauseBtn.setText(paused ? "▶" : "⏸");
    this.pausedBadge.setVisible(paused);
    this.budgetBadge.setVisible(this.budgetReached);
    // badges stack right-to-left, left of the status readout
    let right = W - 3 - this.statusText.width - 5;
    this.pausedBadge.setX(right);
    if (paused) right -= this.pausedBadge.width + 4;
    this.budgetBadge.setX(right);

    for (const [s, btn] of this.speedBtns) {
      const active = s === speed;
      btn.setStyle({
        backgroundColor: active ? "#73daca" : "#2a2f3a",
        color: active ? "#101014" : "#e6e6e6",
      });
    }
  }

  // -- event log ----------------------------------------------------------------

  private buildEventLogChrome(): void {
    this.add
      .rectangle(2, LOG_Y, LOG_W, LOG_H, 0x101218, 0.72)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    for (let i = 0; i < LOG_LINES; i++) {
      this.logTexts.push(
        this.add
          .text(6, LOG_Y + 4 + i * LOG_LINE_H, "", {
            fontFamily: FONT,
            fontSize: "6px",
            color: "#9aa0aa",
          })
          .setDepth(DEPTH_HUD_TEXT),
      );
    }
  }

  private renderEventLog(): void {
    const events = this.eventLog.list(LOG_LINES); // newest-first
    for (let i = 0; i < LOG_LINES; i++) {
      const line = this.logTexts[i];
      const e = events[i];
      if (e) {
        line.setText(formatEventLine(e, 60));
        line.setColor(toCssColor(eventColor(e)));
      } else if (line.text !== "") {
        line.setText("");
      }
    }
  }

  // -- agent cards ----------------------------------------------------------------

  private renderCards(): void {
    const agents = this.conn?.controls.agents() ?? [];
    const compact = agents.length >= 4;
    const layoutKey = `${compact ? "c" : "n"}:${agents.map((a) => a.name).join(",")}`;
    if (layoutKey !== this.cardLayoutKey) {
      this.destroyCards();
      this.cardLayoutKey = layoutKey;
      const cardH = compact ? 54 : 70;
      agents.forEach((agent, i) => {
        this.cards.set(
          agent.name,
          this.createCard(agent.name, CARD_TOP + i * (cardH + 3), cardH, compact),
        );
      });
    }
    for (const agent of agents) {
      const ui = this.cards.get(agent.name);
      if (ui) this.updateCard(ui, buildAgentCard(agent), compact);
    }
  }

  private destroyCards(): void {
    for (const ui of this.cards.values()) {
      for (const obj of Object.values(ui)) {
        (obj as Phaser.GameObjects.GameObject | null)?.destroy();
      }
    }
    this.cards.clear();
  }

  /** Flat absolute-positioned children — no containers (Phaser 4.1 gotcha). */
  private createCard(name: string, y: number, cardH: number, compact: boolean): CardUi {
    const x = CARD_X;
    const small = { fontFamily: FONT, fontSize: "6px", color: "#9aa0aa" };
    const text = (
      tx: number,
      ty: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add.text(tx, ty, "", style).setDepth(DEPTH_HUD_TEXT);

    const bg = this.add
      .rectangle(x, y, CARD_W, cardH, 0x14161c, 0.93)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x2a2f3a, 1)
      .setDepth(DEPTH_HUD)
      .setInteractive({ useHandCursor: true });
    bg.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () =>
      this.toggleTracePanel(name),
    );

    const rowGold = compact ? y + 11 : y + 20;
    const rowGoal = compact ? y + 19 : y + 28;
    const rowThought = compact ? y + 27 : y + 36;
    const rowAction = compact ? y + 35 : y + 52;
    const rowMeta = compact ? y + 44 : y + 61;

    return {
      bg,
      name: text(x + 4, y + 3, {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#ffffff",
        fontStyle: "bold",
      }),
      fsm: text(x + CARD_W - 4, y + 3, { ...small }).setOrigin(1, 0),
      persona: compact ? null : text(x + 4, y + 12, { ...small }),
      gold: text(x + 4, rowGold, { fontFamily: FONT, fontSize: "7px", color: "#ffd700" }),
      energyBg: this.add
        .rectangle(x + 40, rowGold + 2, 50, 4, 0x30343c, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyFill: this.add
        .rectangle(x + 40, rowGold + 2, 50, 4, 0x9ece6a, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyText: text(x + CARD_W - 4, rowGold, { ...small }).setOrigin(1, 0),
      goal: text(x + 4, rowGoal, { ...small, color: "#73daca" }),
      thought: text(x + 4, rowThought, {
        ...small,
        color: "#c8ccd4",
        wordWrap: { width: CARD_W - 8 },
      }),
      action: text(x + 4, rowAction, { fontFamily: FONT, fontSize: "7px", color: "#9ece6a" }),
      meta: text(x + 4, rowMeta, { ...small, color: "#6f7682" }),
    };
  }

  private updateCard(ui: CardUi, card: AgentCardModel, compact: boolean): void {
    ui.name.setText(card.name);
    ui.fsm.setText(card.fsm).setColor(FSM_COLORS[card.fsm] ?? "#8a8f98");
    ui.persona?.setText(this.clip(card.persona, 30));
    ui.gold.setText(`${card.gold}g`);
    this.updateEnergy(ui, card.energy);
    ui.goal.setText(this.clip(`goal: ${card.goal ?? "—"}`, 32));
    // ~22 wrapped chars/line at 6px in CARD_W-8 → clip to guarantee ≤2 lines
    ui.thought.setText(
      card.lastThought ? this.clip(card.lastThought, compact ? 21 : 43) : "…",
    );
    if (card.lastAction) {
      const { action, ok, reason } = card.lastAction;
      ui.action
        .setText(
          this.clip(`${action} ${ok ? "✓" : "✗"}${!ok && reason ? ` ${reason}` : ""}`, 30),
        )
        .setColor(ok ? "#9ece6a" : "#f7768e");
    } else {
      ui.action.setText("—").setColor("#6f7682");
    }
    const tok =
      card.tokensIn !== null || card.tokensOut !== null
        ? ` · ${card.tokensIn ?? "?"}/${card.tokensOut ?? "?"}t`
        : "";
    ui.meta.setText(
      this.clip(
        `${card.model ?? "—"} · ${card.latencyMs ?? "—"}ms${tok} · d${card.decisionsToday}/${card.decisionsTotal}`,
        34,
      ),
    );
  }

  private updateEnergy(ui: CardUi, energy: number): void {
    const ratio = Phaser.Math.Clamp(energy, 0, 100) / 100;
    ui.energyFill.setSize(Math.max(1, Math.round(50 * ratio)), 4);
    ui.energyFill.setFillStyle(
      ratio > 0.5 ? 0x9ece6a : ratio > 0.25 ? 0xe0af68 : 0xf7768e,
    );
    ui.energyText.setText(`E${Math.round(energy)}`);
  }

  private clip(text: string, maxChars: number): string {
    const flat = text.replace(/\s+/g, " ");
    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  }

  // -- decision trace panel ---------------------------------------------------

  private toggleTracePanel(name: string): void {
    if (this.selectedAgent === name) {
      this.closePanel();
      return;
    }
    this.closePanel();
    this.selectedAgent = name;
    this.traceScroll = 0;
    this.expandedTurnIds.clear();
    this.buildPanelChrome(name);
    this.rebuildPanelEntries();
  }

  private buildPanelChrome(name: string): void {
    const bg = this.add
      .rectangle(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 0x101218, 0.94)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x2a2f3a, 1)
      .setDepth(DEPTH_PANEL);
    const title = this.add
      .text(PANEL_X + 4, PANEL_Y + 3, `${name} — decision trace (click entry, wheel scrolls)`, {
        fontFamily: FONT,
        fontSize: "6px",
        color: "#e6e6e6",
      })
      .setDepth(DEPTH_PANEL + 1);
    const close = this.add
      .text(PANEL_X + PANEL_W - 4, PANEL_Y + 2, "✕", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#f7768e",
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_PANEL + 1)
      .setInteractive({ useHandCursor: true });
    close.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => this.closePanel());

    this.panelObjects = [bg, title, close];
  }

  private closePanel(): void {
    this.selectedAgent = null;
    for (const obj of this.panelEntries) obj.destroy();
    this.panelEntries = [];
    for (const obj of this.panelObjects) obj.destroy();
    this.panelObjects = [];
  }

  /** Rebuild entry texts (content changed); positions set by layoutPanel(). */
  private rebuildPanelEntries(): void {
    const name = this.selectedAgent;
    if (!name) return;
    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    for (const obj of this.panelEntries) obj.destroy();
    this.panelEntries = [];
    if (!agent) return;

    const entries = buildAgentCard(agent).trace.slice(0, PANEL_VISIBLE_TRACE);
    for (const entry of entries) {
      const expanded = this.expandedTurnIds.has(entry.turnId);
      const content = expanded
        ? `▾ ${formatTraceSummary(entry, 56)}\n${this.indent(formatTraceEntry(entry))}`
        : `▸ ${formatTraceSummary(entry, 56)}`;
      const textObj = this.add
        .text(PANEL_X + 5, 0, content, {
          fontFamily: FONT,
          fontSize: "6px",
          color: expanded ? "#c8ccd4" : "#9aa0aa",
          // advanced wrap: raw JSON has no spaces, must hard-break long runs
          wordWrap: { width: PANEL_W - 12, useAdvancedWrap: true },
        })
        .setDepth(DEPTH_PANEL + 1)
        .setInteractive({ useHandCursor: true });
      textObj.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () =>
        this.toggleTraceEntry(entry),
      );
      this.panelEntries.push(textObj);
    }
    if (entries.length === 0) {
      const empty = this.add
        .text(PANEL_X + 5, 0, "(no decisions yet)", {
          fontFamily: FONT,
          fontSize: "6px",
          color: "#6f7682",
        })
        .setDepth(DEPTH_PANEL + 1);
      this.panelEntries.push(empty);
    }
    this.layoutPanel();
  }

  private toggleTraceEntry(entry: DecisionTraceEntry): void {
    if (this.expandedTurnIds.has(entry.turnId)) {
      this.expandedTurnIds.delete(entry.turnId);
    } else {
      this.expandedTurnIds.add(entry.turnId);
    }
    this.rebuildPanelEntries();
  }

  /**
   * Stack entries vertically from the (clamped) scroll offset, clipping to
   * the panel window via visibility + setCrop — GeometryMask is unsupported
   * by Phaser 4's WebGL renderer.
   */
  private layoutPanel(): void {
    const top = PANEL_Y + 14;
    const availH = PANEL_H - 16;
    const bottom = top + availH;
    this.panelContentH = this.panelEntries.reduce((h, t) => h + t.height + 4, 0);
    const minScroll = Math.min(0, availH - this.panelContentH);
    this.traceScroll = Phaser.Math.Clamp(this.traceScroll, minScroll, 0);
    let y = top + this.traceScroll;
    for (const t of this.panelEntries) {
      t.setY(y);
      const h = t.height;
      if (y + h <= top || y >= bottom) {
        t.setVisible(false);
      } else {
        t.setVisible(true);
        const cropTop = Math.max(0, top - y);
        const cropBottom = Math.max(0, y + h - bottom);
        if (cropTop > 0 || cropBottom > 0) {
          t.setCrop(0, cropTop, t.width, h - cropTop - cropBottom);
        } else if (t.isCropped) {
          t.setCrop();
        }
      }
      y += h + 4;
    }
  }

  private indent(block: string): string {
    return block
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
  }

  private onWheel(pointer: Phaser.Input.Pointer, deltaY: number): void {
    if (!this.selectedAgent) return;
    const inPanel =
      pointer.x >= PANEL_X &&
      pointer.x <= PANEL_X + PANEL_W &&
      pointer.y >= PANEL_Y &&
      pointer.y <= PANEL_Y + PANEL_H;
    if (!inPanel) return;
    this.traceScroll -= deltaY * 0.25;
    this.layoutPanel();
  }
}
