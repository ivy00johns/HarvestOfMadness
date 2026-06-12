/**
 * UIScene — spectator HUD (§8), pure Phaser (canvas-rendered, DOM-free).
 *
 * Runs as a parallel scene over WorldScene (auto-started via `active: true`;
 * last in main.ts' scene array, so it renders on top). Layout in the logical
 * 768x576 space (24*32 x 18*32 — see src/obs/layout.ts, where the math is
 * pure and unit-tested):
 *   - top row: controls (pause/step/speed) left, Day/phase/speed right
 *   - badge row: the kill-switch badge (rule 13 — LIVE / LLM OFFLINE / MOCK
 *     MODE) centered, PAUSED + BUDGET badges beside it
 *   - agent cards: right column — sprite-color swatch, gold/energy, PLAN
 *     step, goal, thought, last action, affinity meter (top 3), M:/R: stats;
 *     click a card (or a feed turn line) to open its decision trace panel
 *   - event feed: bottom-left — collapsed decision turns (one line per
 *     turnId), "— Day N —" separators, emphasized dialogue lines
 *
 * Contract rule 14: every font ≥ 12px effective at zoom 1, integer pixel
 * positions. Update discipline (§8): re-render on EventBus events with a
 * ~150ms trailing throttle plus a 500ms live timer for energy/FSM/clock —
 * NEVER per-frame text rebuilds. No nested containers (Phaser 4.1 gotcha).
 *
 * Input: card/feed/panel clicks are resolved by a scene-level pointerdown
 * hit-test against the pure layout rects — per-object setInteractive on
 * freshly (re)created objects missed the first click in v1 (input plugin
 * registers new hit areas a tick late). Only the long-lived top-bar buttons
 * keep per-object handlers.
 */
import Phaser from "phaser";
import type { DecisionTraceEntry, WorldEvent } from "@contracts/types";
import {
  FeedModel,
  formatFeedItem,
  type FeedItem,
} from "../obs/Feed";
import {
  KillSwitchModel,
  killSwitchLabel,
  killSwitchStyle,
} from "../obs/KillSwitch";
import { toCssColor } from "../obs/EventLog";
import {
  buildAgentCard,
  formatAffinityRow,
  formatTraceEntry,
  formatTraceSummary,
  personaText,
  topRelationships,
  type ObsAgentCardModel,
} from "../obs/Inspector";
import {
  BADGE_ROW_Y,
  CARD_W,
  FONT_SIZE_BASE,
  FONT_SIZE_SMALL,
  FONT_SIZE_TITLE,
  HUD_FONT,
  HUD_W,
  LOG_H,
  LOG_LINES,
  LOG_LINE_H,
  LOG_MAX_CHARS,
  LOG_PAD_X,
  LOG_PAD_Y,
  LOG_W,
  LOG_X,
  LOG_Y,
  PANEL_CLOSE_RECT,
  PANEL_H,
  PANEL_HEADER_H,
  PANEL_RECT,
  PANEL_VISIBLE_TRACE,
  PANEL_W,
  PANEL_X,
  PANEL_Y,
  TOPBAR_H,
  cardIndexAt,
  cardRect,
  feedLineIndexAt,
  pointInRect,
} from "../obs/layout";
import type { ObsConnection } from "../obs/wiring";
import { connectObservability } from "../obs/wiring";
import { startAgents } from "../agents/bootstrap";
import { getTimeSystem } from "../world/instance";

// -- local style (config.ts is render-agent's file; obs colors live here) -----

const PX_SMALL = `${FONT_SIZE_SMALL}px`;
const PX_BASE = `${FONT_SIZE_BASE}px`;
const PX_TITLE = `${FONT_SIZE_TITLE}px`;

const COLOR_TEXT = "#e6e6e6";
const COLOR_DIM = "#9aa0aa";
const COLOR_FAINT = "#6f7682";
const COLOR_GOLD = "#ffd700";
const COLOR_GOAL = "#73daca";
const COLOR_PLAN = "#7aa2f7";
const COLOR_OK = "#9ece6a";
const COLOR_BAD = "#f7768e";
const COLOR_CHROME = 0x101218;
const COLOR_CARD_BG = 0x14161c;
const COLOR_BORDER = 0x3d4456;

const FSM_COLORS: Record<string, string> = {
  IDLE: "#8a8f98",
  THINKING: "#e0af68",
  EXECUTING: "#9ece6a",
};

const PHASE_ICON: Record<string, string> = {
  morning: "☀",
  afternoon: "☼",
  evening: "☾",
  night: "✦",
};

const SPEEDS = [0.5, 1, 2, 4] as const;

const DEPTH_HUD = 100;
const DEPTH_HUD_TEXT = 101;
const DEPTH_BADGE = 150;
const DEPTH_PANEL = 200;

const REFRESH_THROTTLE_MS = 150;
const LIVE_TIMER_MS = 500;

/** VITE_MODEL_MODE, read defensively (absent under plain node / tests). */
function detectModelMode(): string | undefined {
  try {
    return typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env.VITE_MODEL_MODE as string | undefined)
      : undefined;
  } catch {
    return undefined;
  }
}

interface CardUi {
  bg: Phaser.GameObjects.Rectangle;
  swatch: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  fsm: Phaser.GameObjects.Text;
  gold: Phaser.GameObjects.Text;
  energyBg: Phaser.GameObjects.Rectangle;
  energyFill: Phaser.GameObjects.Rectangle;
  energyText: Phaser.GameObjects.Text;
  plan: Phaser.GameObjects.Text;
  goal: Phaser.GameObjects.Text;
  thought: Phaser.GameObjects.Text | null;
  action: Phaser.GameObjects.Text;
  relRows: Phaser.GameObjects.Text[];
  meta: Phaser.GameObjects.Text;
}

export class UIScene extends Phaser.Scene {
  private conn: ObsConnection | null = null;
  private readonly feed = new FeedModel();
  private readonly killSwitch = new KillSwitchModel(detectModelMode());
  private readonly unsubscribers: Array<() => void> = [];
  private destroyed = false;

  private budgetReached = false;
  private refreshPending = false;

  // top bar + badge row
  private statusText!: Phaser.GameObjects.Text;
  private killBadge!: Phaser.GameObjects.Text;
  private pausedBadge!: Phaser.GameObjects.Text;
  private budgetBadge!: Phaser.GameObjects.Text;
  private pauseBtn!: Phaser.GameObjects.Text;
  private speedBtns = new Map<number, Phaser.GameObjects.Text>();

  // event feed
  private logTexts: Phaser.GameObjects.Text[] = [];
  /** feed item behind each rendered line (click → trace panel) */
  private feedLineItems: Array<FeedItem | null> = [];

  // agent cards
  private cards = new Map<string, CardUi>();
  private cardLayoutKey = "";
  /** card order on screen — index ↔ cardIndexAt() hit test */
  private cardNames: string[] = [];

  // trace panel
  private selectedAgent: string | null = null;
  private readonly expandedTurnIds = new Set<string>();
  private traceScroll = 0;
  private panelObjects: Phaser.GameObjects.GameObject[] = [];
  private panelEntryTexts: Phaser.GameObjects.Text[] = [];
  private panelTraceEntries: DecisionTraceEntry[] = [];

  constructor() {
    super({ key: "ui", active: true });
  }

  create(): void {
    this.scene.bringToTop();
    this.buildTopBar();
    this.buildBadgeRow();
    this.buildFeedChrome();
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) =>
      this.onPointerDown(p.x, p.y),
    );
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

    this.unsubscribers.push(this.feed.attach(conn.bus));
    this.unsubscribers.push(conn.bus.on((e) => this.onBusEvent(e)));
    // sticky states emitted before we attached: budget latch + kill-switch
    for (const e of conn.bus.recent()) {
      if (e.kind === "budget_reached") this.budgetReached = true;
      this.killSwitch.apply(e.kind);
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
    if (this.killSwitch.apply(e.kind)) this.renderBadgeRow();
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
    this.renderBadgeRow();
    this.renderFeed();
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

  // -- input: scene-level hit testing (no dead first click) --------------------

  private onPointerDown(px: number, py: number): void {
    if (this.destroyed) return;
    if (this.selectedAgent) {
      if (pointInRect(px, py, PANEL_CLOSE_RECT)) {
        this.closePanel();
        return;
      }
      if (pointInRect(px, py, PANEL_RECT)) {
        this.onPanelClick(py);
        return; // panel swallows its clicks — nothing leaks to the map
      }
    }
    const count = this.cardNames.length;
    const cardIdx = cardIndexAt(px, py, count);
    if (cardIdx !== null && cardIdx < count) {
      this.toggleTracePanel(this.cardNames[cardIdx]);
      return;
    }
    const lineIdx = feedLineIndexAt(px, py);
    if (lineIdx !== null) {
      const item = this.feedLineItems[lineIdx];
      if (item && item.type === "turn") this.toggleTracePanel(item.agentName);
    }
  }

  private onPanelClick(py: number): void {
    for (let i = 0; i < this.panelEntryTexts.length; i++) {
      const t = this.panelEntryTexts[i];
      if (!t.visible) continue;
      if (py >= t.y && py <= t.y + t.height) {
        const entry = this.panelTraceEntries[i];
        if (entry) this.toggleTraceEntry(entry);
        return;
      }
    }
  }

  // -- top bar: controls + status ----------------------------------------------

  private buildTopBar(): void {
    this.add
      .rectangle(0, 0, HUD_W, TOPBAR_H, COLOR_CHROME, 0.92)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);

    let x = 4;
    const place = (label: string, onClick: () => void): Phaser.GameObjects.Text => {
      const btn = this.makeButton(x, 3, label, onClick);
      x = Math.round(btn.x + btn.width + 4);
      return btn;
    };

    this.pauseBtn = place("⏸", () => this.togglePause());
    place("⏭", () => {
      this.conn?.controls.step();
      this.refreshTopBar();
    });
    for (const speed of SPEEDS) {
      const label = speed === 0.5 ? "½" : `${speed}x`;
      this.speedBtns.set(
        speed,
        place(label, () => {
          this.conn?.controls.setSpeed(speed);
          this.refreshTopBar();
        }),
      );
    }

    this.statusText = this.add
      .text(HUD_W - 6, 5, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: COLOR_TEXT,
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT);

    this.refreshTopBar();
  }

  /** Badge row under the top bar: kill-switch centered, state badges beside. */
  private buildBadgeRow(): void {
    this.add
      .rectangle(0, BADGE_ROW_Y, HUD_W, 20, COLOR_CHROME, 0.92)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    this.killBadge = this.add
      .text(0, BADGE_ROW_Y + 2, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        padding: { x: 8, y: 2 },
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH_BADGE);
    this.pausedBadge = this.add
      .text(0, BADGE_ROW_Y + 2, "PAUSED", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        color: "#ff5555",
        backgroundColor: "#3a1418",
        padding: { x: 6, y: 2 },
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_BADGE)
      .setVisible(false);
    this.budgetBadge = this.add
      .text(0, BADGE_ROW_Y + 2, "BUDGET REACHED", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        color: "#ffb86c",
        backgroundColor: "#3a2a14",
        padding: { x: 6, y: 2 },
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH_BADGE)
      .setVisible(false);
    this.renderBadgeRow();
  }

  private renderBadgeRow(): void {
    if (this.destroyed || !this.killBadge) return;
    const state = this.killSwitch.state();
    const style = killSwitchStyle(state);
    this.killBadge
      .setText(killSwitchLabel(state))
      .setStyle({ color: style.fg, backgroundColor: style.bg });
    const left = Math.round((HUD_W - this.killBadge.width) / 2);
    this.killBadge.setX(left);
    // PAUSED sits left of the kill badge, BUDGET to its right
    const paused = this.conn?.controls.isPaused() ?? false;
    this.pausedBadge.setVisible(paused).setX(left - 8);
    this.budgetBadge
      .setVisible(this.budgetReached)
      .setX(Math.round(left + this.killBadge.width + 8));
  }

  private makeButton(
    x: number,
    y: number,
    label: string,
    onClick: () => void,
  ): Phaser.GameObjects.Text {
    const btn = this.add
      .text(x, y, label, {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: COLOR_TEXT,
        backgroundColor: "#2a2f3a",
        padding: { x: 6, y: 2 },
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
    this.renderBadgeRow();
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
    if (this.pausedBadge) this.pausedBadge.setVisible(paused);

    for (const [s, btn] of this.speedBtns) {
      const active = s === speed;
      btn.setStyle({
        backgroundColor: active ? "#73daca" : "#2a2f3a",
        color: active ? "#101014" : COLOR_TEXT,
      });
    }
  }

  // -- event feed ----------------------------------------------------------------

  private buildFeedChrome(): void {
    this.add
      .rectangle(LOG_X, LOG_Y, LOG_W, LOG_H, COLOR_CHROME, 0.85)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD);
    for (let i = 0; i < LOG_LINES; i++) {
      this.logTexts.push(
        this.add
          .text(LOG_X + LOG_PAD_X, LOG_Y + LOG_PAD_Y + i * LOG_LINE_H, "", {
            fontFamily: HUD_FONT,
            fontSize: PX_SMALL,
            color: COLOR_DIM,
          })
          .setDepth(DEPTH_HUD_TEXT),
      );
      this.feedLineItems.push(null);
    }
  }

  private renderFeed(): void {
    const items = this.feed.list(LOG_LINES); // newest-first
    for (let i = 0; i < LOG_LINES; i++) {
      const line = this.logTexts[i];
      const item = items[i] ?? null;
      this.feedLineItems[i] = item;
      if (item) {
        const view = formatFeedItem(item, LOG_MAX_CHARS);
        line.setText(view.text);
        line.setColor(toCssColor(view.color));
        line.setFontStyle(view.emphasis ? "bold" : "normal");
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
      this.cardNames = agents.map((a) => a.name);
      agents.forEach((agent, i) => {
        const rect = cardRect(i, agents.length);
        this.cards.set(
          agent.name,
          this.createCard(rect.x, rect.y, rect.h, compact),
        );
      });
    }
    for (const agent of agents) {
      const ui = this.cards.get(agent.name);
      if (ui) this.updateCard(ui, buildAgentCard(agent));
    }
  }

  private destroyCards(): void {
    for (const ui of this.cards.values()) {
      for (const obj of Object.values(ui)) {
        if (Array.isArray(obj)) {
          for (const o of obj) o.destroy();
        } else {
          (obj as Phaser.GameObjects.GameObject | null)?.destroy();
        }
      }
    }
    this.cards.clear();
    this.cardNames = [];
  }

  /** Flat absolute-positioned children — no containers (Phaser 4.1 gotcha). */
  private createCard(x: number, y: number, cardH: number, compact: boolean): CardUi {
    const small = { fontFamily: HUD_FONT, fontSize: PX_SMALL, color: COLOR_DIM };
    const text = (
      tx: number,
      ty: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add.text(tx, ty, "", style).setDepth(DEPTH_HUD_TEXT);

    const bg = this.add
      .rectangle(x, y, CARD_W, cardH, COLOR_CARD_BG, 0.93)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0x2a2f3a, 1)
      .setDepth(DEPTH_HUD);

    // visual sprite link (v1 defect c): swatch in the agent's sprite color
    const swatch = this.add
      .rectangle(x + 6, y + 6, 11, 11, 0xffffff, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0xffffff, 0.6)
      .setDepth(DEPTH_HUD_TEXT);

    const rowGold = y + 20;
    const rowPlan = y + 34;
    const rowGoal = y + 48;
    const rowThought = y + 62; // 2 wrapped lines reserved (normal mode)
    const rowAction = compact ? y + 62 : y + 90;
    const relRowCount = compact ? 1 : 3;
    const rowRel = compact ? y + 76 : y + 104;
    const rowMeta = compact ? y + 90 : y + 146;

    const relRows: Phaser.GameObjects.Text[] = [];
    for (let i = 0; i < relRowCount; i++) {
      relRows.push(text(x + 6, rowRel + i * 14, { ...small }));
    }

    return {
      bg,
      swatch,
      name: text(x + 22, y + 4, {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: "#ffffff",
        fontStyle: "bold",
      }),
      fsm: text(x + CARD_W - 6, y + 4, { ...small }).setOrigin(1, 0),
      gold: text(x + 6, rowGold, {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        color: COLOR_GOLD,
      }),
      energyBg: this.add
        .rectangle(x + 76, rowGold + 3, 90, 8, 0x30343c, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyFill: this.add
        .rectangle(x + 76, rowGold + 3, 90, 8, 0x9ece6a, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyText: text(x + CARD_W - 6, rowGold, { ...small }).setOrigin(1, 0),
      plan: text(x + 6, rowPlan, { ...small, color: COLOR_PLAN }),
      goal: text(x + 6, rowGoal, { ...small, color: COLOR_GOAL }),
      thought: compact
        ? null
        : text(x + 6, rowThought, {
            ...small,
            color: "#c8ccd4",
            wordWrap: { width: CARD_W - 12 },
          }),
      action: text(x + 6, rowAction, {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        color: COLOR_OK,
      }),
      relRows,
      meta: text(x + 6, rowMeta, { ...small, color: COLOR_FAINT }),
    };
  }

  private updateCard(ui: CardUi, card: ObsAgentCardModel): void {
    if (typeof card.color === "number") ui.swatch.setFillStyle(card.color, 1);
    ui.name.setText(this.clip(card.name, 22));
    ui.fsm.setText(card.fsm).setColor(FSM_COLORS[card.fsm] ?? "#8a8f98");
    ui.gold.setText(`${card.gold}g`);
    this.updateEnergy(ui, card.energy);

    // v2: current plan step ("PLAN: water east plot") — hidden when absent
    ui.plan.setText(card.planStep ? this.clip(`PLAN: ${card.planStep}`, 30) : "");
    ui.goal.setText(this.clip(`goal: ${card.goal ?? "—"}`, 30));
    // ~30 wrapped chars/line at 12px in CARD_W-12 → clip to guarantee ≤2 lines
    ui.thought?.setText(card.lastThought ? this.clip(card.lastThought, 58) : "…");

    if (card.lastAction) {
      const { action, ok, reason } = card.lastAction;
      ui.action
        .setText(
          this.clip(`${action} ${ok ? "✓" : "✗"}${!ok && reason ? ` ${reason}` : ""}`, 30),
        )
        .setColor(ok ? COLOR_OK : COLOR_BAD);
    } else {
      ui.action.setText("—").setColor(COLOR_FAINT);
    }

    // v2: affinity meter — top rows by |affinity|, signed bar + number
    const rels = topRelationships(card.relationships ?? [], ui.relRows.length);
    for (let i = 0; i < ui.relRows.length; i++) {
      const row = ui.relRows[i];
      const rel = rels[i];
      if (rel) {
        row.setText(formatAffinityRow(rel.name, rel.affinity));
        row.setColor(
          rel.affinity > 0 ? COLOR_OK : rel.affinity < 0 ? COLOR_BAD : COLOR_DIM,
        );
      } else if (row.text !== "") {
        row.setText("");
      }
    }

    // v2: memory/reflection stats — agent-provided counts win, the feed's
    // event-derived counters (memory_written is feed-suppressed) back them up
    const mem = card.memoryCount ?? this.feed.memoryCount(card.name);
    const refl = card.reflectionCount ?? this.feed.reflectionCount(card.name);
    const tok =
      card.tokensIn !== null || card.tokensOut !== null
        ? ` ${card.tokensIn ?? "?"}/${card.tokensOut ?? "?"}t`
        : "";
    ui.meta.setText(
      this.clip(
        `${card.model ?? "—"} ${card.latencyMs ?? "—"}ms${tok} d${card.decisionsToday}/${card.decisionsTotal} M:${mem} R:${refl}`,
        30,
      ),
    );
  }

  private updateEnergy(ui: CardUi, energy: number): void {
    const ratio = Phaser.Math.Clamp(energy, 0, 100) / 100;
    ui.energyFill.setSize(Math.max(1, Math.round(90 * ratio)), 8);
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
    // v1 defect d: text sat directly on the map — the panel now has a
    // near-opaque backing rect plus a visible border.
    const bg = this.add
      .rectangle(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 0x0e1016, 0.96)
      .setOrigin(0, 0)
      .setStrokeStyle(2, COLOR_BORDER, 1)
      .setDepth(DEPTH_PANEL);
    const title = this.add
      .text(PANEL_X + 8, PANEL_Y + 4, `${name} — decision trace`, {
        fontFamily: HUD_FONT,
        fontSize: PX_TITLE,
        fontStyle: "bold",
        color: COLOR_TEXT,
      })
      .setDepth(DEPTH_PANEL + 1);
    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    const subtitle = this.add
      .text(
        PANEL_X + 8,
        PANEL_Y + 21,
        this.clip(
          `${agent ? personaText(agent.persona) : ""} · click a row to expand · wheel scrolls`,
          70,
        ),
        { fontFamily: HUD_FONT, fontSize: PX_SMALL, color: COLOR_FAINT },
      )
      .setDepth(DEPTH_PANEL + 1);
    const close = this.add
      .text(PANEL_X + PANEL_W - 8, PANEL_Y + 4, "✕", {
        fontFamily: HUD_FONT,
        fontSize: PX_TITLE,
        color: COLOR_BAD,
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_PANEL + 1);

    this.panelObjects = [bg, title, subtitle, close];
  }

  private closePanel(): void {
    this.selectedAgent = null;
    for (const obj of this.panelEntryTexts) obj.destroy();
    this.panelEntryTexts = [];
    this.panelTraceEntries = [];
    for (const obj of this.panelObjects) obj.destroy();
    this.panelObjects = [];
  }

  /** Rebuild entry texts (content changed); positions set by layoutPanel(). */
  private rebuildPanelEntries(): void {
    const name = this.selectedAgent;
    if (!name) return;
    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    for (const obj of this.panelEntryTexts) obj.destroy();
    this.panelEntryTexts = [];
    this.panelTraceEntries = [];
    if (!agent) return;

    const entries = buildAgentCard(agent).trace.slice(0, PANEL_VISIBLE_TRACE);
    this.panelTraceEntries = entries;
    for (const entry of entries) {
      const expanded = this.expandedTurnIds.has(entry.turnId);
      const content = expanded
        ? `▾ ${formatTraceSummary(entry, 68)}\n${this.indent(formatTraceEntry(entry))}`
        : `▸ ${formatTraceSummary(entry, 68)}`;
      const textObj = this.add
        .text(PANEL_X + 8, 0, content, {
          fontFamily: HUD_FONT,
          fontSize: PX_SMALL,
          color: expanded ? "#c8ccd4" : COLOR_DIM,
          // advanced wrap: raw JSON has no spaces, must hard-break long runs
          wordWrap: { width: PANEL_W - 16, useAdvancedWrap: true },
        })
        .setDepth(DEPTH_PANEL + 1);
      this.panelEntryTexts.push(textObj);
    }
    if (entries.length === 0) {
      const empty = this.add
        .text(PANEL_X + 8, 0, "(no decisions yet)", {
          fontFamily: HUD_FONT,
          fontSize: PX_SMALL,
          color: COLOR_FAINT,
        })
        .setDepth(DEPTH_PANEL + 1);
      this.panelEntryTexts.push(empty);
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
    const top = PANEL_Y + PANEL_HEADER_H;
    const availH = PANEL_H - PANEL_HEADER_H - 6;
    const bottom = top + availH;
    const contentH = this.panelEntryTexts.reduce((h, t) => h + t.height + 6, 0);
    const minScroll = Math.min(0, availH - contentH);
    this.traceScroll = Phaser.Math.Clamp(this.traceScroll, minScroll, 0);
    let y = Math.round(top + this.traceScroll);
    for (const t of this.panelEntryTexts) {
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
      y += h + 6;
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
    if (!pointInRect(pointer.x, pointer.y, PANEL_RECT)) return;
    this.traceScroll -= deltaY * 0.25;
    this.layoutPanel();
  }
}
