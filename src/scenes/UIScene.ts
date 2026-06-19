/**
 * UIScene — spectator HUD (§8), pure Phaser (canvas-rendered, DOM-free).
 *
 * Runs as a parallel scene over WorldScene. v3: the canvas is fullscreen
 * (Phaser.Scale.RESIZE), so the HUD DOCKS to the live viewport via
 * computeHud(viewW, viewH) (src/obs/layout.ts) and fully rebuilds on the
 * scale RESIZE event. Docking: top row controls + clock; badge row with the
 * kill-switch (rule 13 — LIVE / LLM OFFLINE / MOCK) pinned top-left; agent
 * cards on the right edge; event feed bottom-left; trace panel filling the
 * left-middle band. The open panel's rect is published to the registry so
 * WorldScene ignores camera clicks that land on it.
 *
 * Contract rule 14: every font ≥ 12px effective at zoom 1, integer pixel
 * positions. Update discipline (§8): re-render on EventBus events with a
 * ~150ms trailing throttle plus a 500ms live timer — NEVER per-frame text
 * rebuilds. No nested containers (Phaser 4.1 gotcha).
 */
import Phaser from "phaser";
import type { WorldEvent } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";
import {
  FeedModel,
  formatFeedItem,
  type FeedItem,
} from "../obs/Feed";
import { KillSwitchModel } from "../obs/KillSwitch";
import { toCssColor } from "../obs/EventLog";
import {
  buildAgentCard,
  personaText,
  type ObsAgentCardModel,
} from "../obs/Inspector";
import {
  memoryTagChip,
  modelStrip,
  orderMemoryStream,
  traceNodes,
  type TraceNode,
} from "../obs/inspectorRail";
import {
  FONT_SIZE_BASE,
  FONT_SIZE_KPI_LABEL,
  FONT_SIZE_KPI_VALUE,
  FONT_SIZE_SMALL,
  FONT_SIZE_TITLE,
  HUD_FONT,
  HUD_FONT_BODY,
  KPI_TILE_COUNT,
  MONO_FONT,
  REG_HUD,
  REG_SELECTED,
  computeHud,
  formatEconomy,
  formatPercent,
  pointInRect,
  type HudLayout,
} from "../obs/layout";
import {
  appBg as appBgTok,
  borderCard,
  borderControl,
  borderInspector,
  brand400,
  brand500,
  brand600,
  bubbleGuest,
  bubbleHost,
  card as cardSurface,
  cardSelected,
  cmdGradTop,
  control,
  cyan300,
  cyan500,
  divider,
  ink300,
  ink400,
  ink500,
  insetTile,
  p1,
  p2,
  positive500,
  tintIdle,
  white,
} from "../obs/theme";
import { actionVerbColor, energyLevelColor, stateBadge } from "../obs/cardStyle";
import { formatCognitionMeter } from "../obs/CognitionMeter";
import { buildPartyPanel, type PartyPanelView } from "../obs/PartyPanel";
import { buildGovernancePanel, type GovernancePanelView } from "../obs/GovernancePanel";
import { buildTranscript, conversationFromEvent } from "../obs/Transcript";
import type { Conversation } from "@contracts/types";
import type { ObsConnection } from "../obs/wiring";
import { connectObservability } from "../obs/wiring";
import { startAgents } from "../agents/bootstrap";
import { getTimeSystem } from "../world/instance";

// -- local style (config.ts is render-agent's file; obs colors live here) -----

const PX_SMALL = `${FONT_SIZE_SMALL}px`;
const PX_BASE = `${FONT_SIZE_BASE}px`;
const PX_TITLE = `${FONT_SIZE_TITLE}px`;
const PX_KPI_VALUE = `${FONT_SIZE_KPI_VALUE}px`;
const PX_KPI_LABEL = `${FONT_SIZE_KPI_LABEL}px`;

// SpaceCon palette (cool-navy mission-control): these constants keep their
// names so every existing usage picks up the navy palette, but their VALUES are
// now sourced from the design-token module (src/obs/theme.ts — single source of
// truth). Semantic mapping per contracts/phase-b-foundation.md §Retheme map.
const COLOR_TEXT = white.hex; // body — white
const COLOR_DIM = ink300.hex; // secondary labels — ink300 (body)
const COLOR_DIM_NUM = ink300.num; // ink300 numeric form (feed dot default fill)
const COLOR_FAINT = ink500.hex; // tertiary / faint meta — ink500
const COLOR_GOAL = cyan300.hex; // the one accent → cyan300
const COLOR_PLAN = brand400.hex; // plan → brand400
const COLOR_OK = positive500.hex; // ok → positive500
const COLOR_CHROME = cardSurface.num; // chrome → card surface
const COLOR_CARD_BG = cardSurface.num; // card background → card surface
const COLOR_BORDER = borderCard.num; // separator → card border
const COLOR_HEADER = ink400.hex; // mono section-header labels → ink400
const COLOR_INSET = insetTile.num; // inset mini-stat tiles → insetTile
const COLOR_STAR = brand400.hex; // ★ accent (Active-conversation card title)
const COLOR_BUBBLE_HOST = bubbleHost.num; // host (left) chat bubble fill
const COLOR_BUBBLE_GUEST = bubbleGuest.num; // other-speaker (right) chat bubble fill

// -- SpaceCon INSPECTOR rail (design README §6) — token-sourced, no new hex ----
const INSP_BORDER = borderInspector.num; // inspector card border (#2f4a6b)
const INSP_CTRL_BG = control.num; // close-✕ control fill (#0c1424)
const INSP_CTRL_BORDER = borderControl.num; // close-✕ + model-strip border (#24324d)
const INSP_PERSONA = ink400.hex; // persona sub (#76839B)
const INSP_CONNECTOR = borderCard.num; // trace-timeline connector (#1f2c46)
const INSP_MODEL_MOCK = ink400.hex; // model strip — mock (#76839B)
const INSP_MODEL_LIVE = cyan300.hex; // model strip — live (#7FD3EC)

// -- SpaceCon command bar (design README §1) — token-sourced, no new hex ------
const CMD_BAR_BG = cmdGradTop.num; // flat navy fill (gradient impractical in Phaser)
const CMD_BORDER = borderControl.num; // bar bottom border + segment borders
const CMD_CONTROL_BG = control.num; // rounded transport / speed / mode containers
const CMD_ACTIVE_BG = brand600.num; // selected / active button fill
const CMD_ACTIVE_FG = white.hex; // selected button label
const CMD_IDLE_FG = ink300.hex; // idle button label
const CMD_LABEL = ink400.hex; // mono uppercase labels (clock prefix)
const CMD_WORDMARK_DOT = cyan500.num; // wordmark dot
const CMD_PHASE_GLYPH = p2.hex; // clock phase glyph (amber)
const CMD_COST_OK = positive500.hex; // $0.00 (mock) cost chip color
const CMD_INFLIGHT = cyan300.hex; // in-flight ⟳ chip accent


// -- Map-viewport overlay chips (Phase B-4, design README §3) — token-sourced --
// Context chip (top-left of the map rect): a dark semi-opaque navy fill +
// control border. Backdrop-blur isn't feasible in Phaser canvas — a semi-opaque
// fill is the accepted substitute (contract §2).
const CHIP_CTX_FILL = appBgTok.num; // --ink-900 navy
const CHIP_CTX_ALPHA = 0.6;
const CHIP_CTX_BORDER = borderControl.num; // #24324d
const CHIP_CTX_TEXT = ink300.hex; // mono uppercase label
// Follow chip (top-right, only when an agent is selected): a brand-tinted
// semi-opaque fill + brand400 border, white text (contract §3).
const CHIP_FOLLOW_FILL = brand600.num; // #1e50c8
const CHIP_FOLLOW_ALPHA = 0.5;
const CHIP_FOLLOW_BORDER = brand400.num; // #5187f2
const CHIP_FOLLOW_TEXT = white.hex;
const CHIP_RADIUS = 7;

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
  /** which agent this card currently draws — drives the selected-card style. */
  name: string;
  bg: Phaser.GameObjects.Rectangle;
  swatch: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
  /** state-badge pill (tinted fill) + its uppercase label. */
  badgeBg: Phaser.GameObjects.Rectangle;
  badge: Phaser.GameObjects.Text;
  gold: Phaser.GameObjects.Text;
  energyBg: Phaser.GameObjects.Rectangle;
  energyFill: Phaser.GameObjects.Rectangle;
  energyText: Phaser.GameObjects.Text;
  goal: Phaser.GameObjects.Text;
  /** action verb (verb-colored) + a trailing green ✓ when it succeeded. */
  action: Phaser.GameObjects.Text;
  check: Phaser.GameObjects.Text;
  /** top divider above the thought quote. */
  thoughtRule: Phaser.GameObjects.Rectangle;
  thought: Phaser.GameObjects.Text;
}

export class UIScene extends Phaser.Scene {
  private conn: ObsConnection | null = null;
  private readonly feed = new FeedModel();
  private readonly killSwitch = new KillSwitchModel(detectModelMode());
  private readonly unsubscribers: Array<() => void> = [];
  private destroyed = false;
  /** responsive HUD geometry, recomputed on every resize */
  private hud!: HudLayout;

  private budgetReached = false;
  private refreshPending = false;

  // -- SpaceCon command bar (single full-width top bar, design README §1) -----
  // Left group: wordmark · transport (play/pause + step) · speed · mock/live.
  // Right group: clock · telemetry chips (in-flight, cognition tally, cost) +
  // the BUDGET REACHED indicator. Background rects + interactive Text buttons,
  // all absolute-positioned (no nested containers — Phaser 4.1 gotcha).
  private cmdBar!: Phaser.GameObjects.Rectangle;
  /** Play/Pause toggle — ACTIVE (paused) fills brand600; idle transparent. */
  private pauseBtn!: Phaser.GameObjects.Text;
  /** background rect behind the pause button (the active fill). */
  private pauseBtnBg!: Phaser.GameObjects.Rectangle;
  private speedBtns = new Map<number, Phaser.GameObjects.Text>();
  private speedBtnBgs = new Map<number, Phaser.GameObjects.Rectangle>();
  /** Mock/Live segment buttons + their active-fill backgrounds. */
  private modeBtns = new Map<"mock" | "live", Phaser.GameObjects.Text>();
  private modeBtnBgs = new Map<"mock" | "live", Phaser.GameObjects.Rectangle>();
  /** Clock label "DAY n" + phase name (display, white), right-origin. */
  private clockText!: Phaser.GameObjects.Text;
  /** Clock phase glyph (☀/☼/☾/✦) in amber (p2), sits left of clockText. */
  private clockGlyph!: Phaser.GameObjects.Text;
  /** in-flight chip: count of agents currently THINKING (real). */
  private inflightChip!: Phaser.GameObjects.Text;
  /** cognition tally chip — the real metric the old cogMeter showed. */
  private cogChip!: Phaser.GameObjects.Text;
  /** cost chip — $0.00 in mock (positive), honest $— placeholder in live. */
  private costChip!: Phaser.GameObjects.Text;
  /** BUDGET REACHED indicator, folded into the bar (driven by budgetReached). */
  private budgetBadge!: Phaser.GameObjects.Text;

  // B-3 — KPI band: five run-level number tiles in the left column, directly
  // below the command bar and above the map. Each tile: a backing rect, a mono
  // uppercase label, and a display-700 value. Values read REAL sim data.
  private kpiBg: Phaser.GameObjects.Rectangle[] = [];
  private kpiLabels: Phaser.GameObjects.Text[] = [];
  private kpiValues: Phaser.GameObjects.Text[] = [];

  // B-6 — Active-conversation card (right-rail DEFAULT state, README §5): the
  // consolidated upper card combining the gathering stats (buildPartyPanel) and
  // the conversation thread (buildTranscript), plus a compact governance line
  // when a town proposal is open. Replaces the old party + governance + transcript
  // banners with ONE card drawn into hud.activeConvRect.
  private acvBg: Phaser.GameObjects.Rectangle | null = null;
  /** Mono uppercase card header ("ACTIVE CONVERSATION"). */
  private acvHeader: Phaser.GameObjects.Text | null = null;
  /** ★ glyph (brand400) + title (gathering description / conversation parties). */
  private acvStar: Phaser.GameObjects.Text | null = null;
  private acvTitle: Phaser.GameObjects.Text | null = null;
  /** "host {name} · day N {phase}" sub. */
  private acvSub: Phaser.GameObjects.Text | null = null;
  /** Three mini-stat tiles: {bg, label, value} (Know N/M · Invited K · Arrived J). */
  private acvTileBgs: Phaser.GameObjects.Rectangle[] = [];
  private acvTileLabels: Phaser.GameObjects.Text[] = [];
  private acvTileValues: Phaser.GameObjects.Text[] = [];
  /** Compact governance proposal line (⚖ ruleText · tally), folded into this card. */
  private acvGov: Phaser.GameObjects.Text | null = null;
  /** Chat thread: per-line tinted bubble rect + body text (host left / other right). */
  private acvBubbleBgs: Phaser.GameObjects.Rectangle[] = [];
  private acvBubbleTexts: Phaser.GameObjects.Text[] = [];
  /** Honest empty state ("No active conversation") when there is neither a
   *  gathering nor a conversation to show. */
  private acvEmpty: Phaser.GameObjects.Text | null = null;
  /** Whether the Active-conversation card is currently shown (not overlaid by
   *  the trace panel) — gates the HUD click-through guard. */
  private acvVisible = false;
  /** rows the chat thread can show (one bubble per line). The right-panel
   *  conversation region is tall now, so we show a deeper backlog. */
  private static readonly TRANSCRIPT_MAX_LINES = 14;
  /** latest conversation parsed off the bus, rendered when no panel overlays it */
  private latestConversation: Conversation | null = null;
  /** arrivals accumulated from the bus (event_arrived), keyed by eventId.
   *  Scene state — survives relayout(); arrivals live in Cognition, not EventBoard. */
  private readonly arrivedByEvent = new Map<string, Set<string>>();

  // B-4 — map-viewport overlay chips (drawn over the map region by UIScene,
  // which owns HUD chrome + knows hud.mapRect). The context chip is always
  // visible (top-left); the follow chip shows only when an agent is selected
  // (top-right). Graphics for rounded fills + Text labels (no nested
  // containers — Phaser 4.1 gotcha). Repositioned on relayout.
  private ctxChipGfx: Phaser.GameObjects.Graphics | null = null;
  private ctxChipText: Phaser.GameObjects.Text | null = null;
  private followChipGfx: Phaser.GameObjects.Graphics | null = null;
  private followChipText: Phaser.GameObjects.Text | null = null;

  // event feed
  private logTexts: Phaser.GameObjects.Text[] = [];
  /** per-row event-kind color dot (README §5): reuses the feed line's color,
   *  which derives from the EventLog kind→color map. */
  private logDots: Phaser.GameObjects.Arc[] = [];
  /** feed item behind each rendered line (click → trace panel) */
  private feedLineItems: Array<FeedItem | null> = [];

  // agent cards
  private cards = new Map<string, CardUi>();
  private cardLayoutKey = "";
  /** card order on screen — index ↔ cardIndexAt() hit test (windowed view) */
  private cardNames: string[] = [];
  /** horizontal scroll: index of the FIRST agent shown in the strip window */
  private cardScroll = 0;
  /** accumulated wheel delta — trackpads fire many small events, so we only
   *  advance one card per WHEEL_NOTCH of travel (no "flying through" blur). */
  private cardScrollAccum = 0;

  // INSPECTOR rail (right-rail INSPECTOR state, README §6): one tall card that
  // REPLACES the DEFAULT Active-conversation card in place (panelRect ===
  // activeConvRect). `panelObjects` holds the fixed chrome (bg, header, close,
  // stat strip); `panelEntryTexts` holds the scrollable content below the stat
  // strip (trace timeline + model strip + memory stream) — the wheel scrolls
  // this list when it overflows the card.
  private selectedAgent: string | null = null;
  private traceScroll = 0;
  private panelObjects: Phaser.GameObjects.GameObject[] = [];
  private panelEntryTexts: Phaser.GameObjects.GameObject[] = [];
  /** scrollable content objects with their unscrolled base-Y + height (the
   *  trace timeline + model strip + memory stream below the fixed stat strip). */
  private panelContent: Array<{
    obj: Phaser.GameObjects.GameObject & { setY(y: number): unknown; setVisible(v: boolean): unknown };
    baseY: number;
    h: number;
  }> = [];
  /** y the scrollable content region starts at (just below the stat strip). */
  private panelContentTop = 0;
  /** total laid-out content height (drives scroll clamp). */
  private panelContentH = 0;

  constructor() {
    super({ key: "ui", active: true });
  }

  create(): void {
    this.scene.bringToTop();
    this.hud = computeHud(this.scale.width, this.scale.height);
    this.buildCommandBar();
    this.buildSectionHeaders();
    this.buildKpiBand();
    this.buildFeedChrome();
    this.buildActiveConvChrome();
    this.buildMapOverlays();
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
    this.scale.on(Phaser.Scale.Events.RESIZE, this.relayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.destroyed = true;
      this.scale.off(Phaser.Scale.Events.RESIZE, this.relayout, this);
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers.length = 0;
    });
    // bootstrap.ts delegates the start call to the main.ts-carve-out owner
    // (us); it self-defers until WorldScene publishes its RenderApi.
    startAgents();
    this.connect();
  }

  /**
   * Rebuild the entire HUD against the new viewport size. UIScene contains only
   * HUD chrome, so removeAll(true) is a safe full teardown; input handlers and
   * the live timer live on the scene (not children) and persist, reading the
   * fresh this.hud. Transient panel selection is reopened with new geometry.
   */
  private relayout(): void {
    if (this.destroyed) return;
    this.hud = computeHud(this.scale.width, this.scale.height);
    const reopen = this.selectedAgent;
    this.children.removeAll(true);
    this.cards.clear();
    this.cardNames = [];
    this.cardLayoutKey = "";
    this.logTexts = [];
    this.logDots = [];
    this.feedLineItems = [];
    this.panelObjects = [];
    this.panelEntryTexts = [];
    this.panelContent = [];
    this.selectedAgent = null;
    // removeAll(true) destroyed the Active-conversation card objects — drop the
    // stale refs; buildActiveConvChrome() recreates them. arrivedByEvent +
    // latestConversation are sim state, kept across relayout.
    this.acvBg = null;
    this.acvHeader = null;
    this.acvStar = null;
    this.acvTitle = null;
    this.acvSub = null;
    this.acvTileBgs = [];
    this.acvTileLabels = [];
    this.acvTileValues = [];
    this.acvGov = null;
    this.acvBubbleBgs = [];
    this.acvBubbleTexts = [];
    this.acvEmpty = null;
    this.acvVisible = false;
    // removeAll(true) destroyed the map-overlay chips — drop stale refs;
    // buildMapOverlays() recreates them against the fresh mapRect.
    this.ctxChipGfx = null;
    this.ctxChipText = null;
    this.followChipGfx = null;
    this.followChipText = null;
    this.agentsHeader = null;
    // removeAll(true) destroyed the KPI band objects too — drop stale refs;
    // buildKpiBand() recreates them (the values are re-derived from sim data).
    this.kpiBg = [];
    this.kpiLabels = [];
    this.kpiValues = [];
    // removeAll(true) destroyed the command-bar children — drop stale refs in
    // the segment maps so buildCommandBar() repopulates them cleanly.
    this.speedBtns.clear();
    this.speedBtnBgs.clear();
    this.modeBtns.clear();
    this.modeBtnBgs.clear();
    this.buildCommandBar();
    this.buildSectionHeaders();
    this.buildKpiBand();
    this.buildFeedChrome();
    this.buildActiveConvChrome();
    this.buildMapOverlays();
    this.refreshAll();
    this.renderMapOverlays();
    if (reopen) this.toggleTracePanel(reopen);
    this.publishPanelRect();
    this.publishSelected();
  }

  /** Live "AGENTS · N" count label above the bottom strip (updated as agents
   *  appear). Created in buildSectionHeaders, refreshed in renderCards. */
  private agentsHeader: Phaser.GameObjects.Text | null = null;

  /**
   * Persistent chrome for the new v4 regions:
   *  - a full-height backing rect + top divider for the RIGHT conversation /
   *    events panel,
   *  - a backing rect + top divider for the BOTTOM agent strip,
   *  - the section-header labels: "CONVERSATION" (top of the right panel),
   *    "AGENTS · N" (above the bottom strip). The "EVENTS" header is drawn in
   *    buildFeedChrome (its gutter sits just above the feed in the right panel).
   * Pure chrome — recreated on relayout by children.removeAll(true).
   */
  private buildSectionHeaders(): void {
    const r = this.hud.rightRect;
    // Right panel backing surface (full height under the top chrome).
    this.add
      .rectangle(r.x, r.y, r.w, r.h, COLOR_CHROME, 0.9)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    this.add
      .rectangle(r.x, r.y, 1, r.h, COLOR_BORDER, 0.8)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    // Bottom strip backing surface.
    this.add
      .rectangle(0, this.hud.stripY, this.hud.rightX, this.hud.stripH, COLOR_CHROME, 0.9)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    this.add
      .rectangle(0, this.hud.stripY, this.hud.rightX, 1, COLOR_BORDER, 0.8)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);

    const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: HUD_FONT,
      fontSize: PX_SMALL,
      fontStyle: "bold",
      color: COLOR_HEADER,
    };
    // The right rail's CONVERSATION region is headed by the Active-conversation
    // card's own mono "ACTIVE CONVERSATION" header (buildActiveConvChrome) — no
    // separate persistent label here (it would double up above the card).
    // AGENTS · N label above the bottom strip.
    this.agentsHeader = this.add
      .text(8, this.hud.stripHeaderY, "AGENTS", headerStyle)
      .setDepth(DEPTH_HUD_TEXT);
  }

  /** WorldScene reads this rect to ignore camera clicks over the open panel.
   *  Priority: an open trace panel (INSPECTOR state) > the visible
   *  Active-conversation card (DEFAULT state) > nothing. Both occupy the same
   *  region (hud.activeConvRect === hud.panelRect). Without this, clicks on the
   *  visible chrome fall through and pan/follow the world map underneath. */
  private publishPanelRect(): void {
    let rect = null;
    if (this.selectedAgent) {
      rect = this.hud.panelRect;
    } else if (this.acvVisible) {
      rect = this.hud.activeConvRect;
    }
    this.registry.set(REG_HUD, rect);
  }

  // -- wiring -----------------------------------------------------------------

  private connect(): void {
    const conn = connectObservability();
    this.conn = conn;

    this.unsubscribers.push(this.feed.attach(conn.bus));
    this.unsubscribers.push(conn.bus.on((e) => this.onBusEvent(e)));
    // sticky states emitted before we attached: budget latch + kill-switch,
    // plus pre-attach event_arrived so the party strip counts early arrivals.
    for (const e of conn.bus.recent()) {
      if (e.kind === "budget_reached") this.budgetReached = true;
      this.killSwitch.apply(e.kind);
      this.accumulateArrival(e);
    }
    this.unsubscribers.push(getTimeSystem().onChange(() => this.refreshClock()));
    this.time.addEvent({
      delay: LIVE_TIMER_MS,
      loop: true,
      callback: () => this.refreshLive(),
    });
    this.refreshAll();
  }

  private onBusEvent(e: WorldEvent): void {
    if (e.kind === "budget_reached") this.budgetReached = true;
    if (this.killSwitch.apply(e.kind)) this.renderModeSegment();
    this.accumulateArrival(e);
    if (e.kind === "conversation") {
      const conv = conversationFromEvent(e);
      if (conv) this.latestConversation = conv;
    }
    this.markDirty();
  }

  /**
   * Accumulate party arrivals from the bus. `event_arrived` carries
   * `{ eventId, agentName }`; arrived state lives in Cognition (not EventBoard),
   * so the strip's arrived count is sourced here. Defensive on payload shape.
   */
  private accumulateArrival(e: WorldEvent): void {
    if (e.kind !== "event_arrived") return;
    const p = e.payload as { eventId?: unknown; agentName?: unknown } | undefined;
    const eventId = typeof p?.eventId === "string" ? p.eventId : undefined;
    const agentName = typeof p?.agentName === "string" ? p.agentName : undefined;
    if (!eventId || !agentName) return;
    let set = this.arrivedByEvent.get(eventId);
    if (!set) {
      set = new Set<string>();
      this.arrivedByEvent.set(eventId, set);
    }
    set.add(agentName);
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
    this.renderCommandBar();
    this.renderKpiBand();
    this.renderFeed();
    this.renderCards();
    this.renderActiveConv();
    if (this.selectedAgent) this.rebuildPanelEntries();
  }

  /** 500ms live tick: clock, energy bars, FSM chips — no full text rebuilds. */
  private refreshLive(): void {
    if (this.destroyed) return;
    this.refreshClock();
    this.renderTelemetry();
    const agents = this.conn?.controls.agents() ?? [];
    for (const agent of agents) {
      const ui = this.cards.get(agent.name);
      if (!ui) continue;
      this.updateEnergy(ui, agent.energy);
      // Keep the state badge live without a full card rebuild.
      const b = stateBadge(agent.fsm);
      ui.badge.setText(b.label).setColor(`#${b.color.toString(16).padStart(6, "0")}`);
      ui.badgeBg.setFillStyle(b.tint.color, b.tint.alpha);
    }
  }

  // -- input: scene-level hit testing (no dead first click) --------------------

  private onPointerDown(px: number, py: number): void {
    if (this.destroyed) return;
    if (this.selectedAgent) {
      if (pointInRect(px, py, this.hud.panelCloseRect)) {
        this.closePanel();
        return;
      }
      if (pointInRect(px, py, this.hud.panelRect)) {
        // INSPECTOR is a fixed structured card (no expandable rows). The only
        // interactive element is the close ✕ (handled above); every other click
        // inside the card is swallowed so nothing leaks to the map underneath.
        return;
      }
    }
    const count = this.cardNames.length;
    const cardIdx = this.hud.cardIndexAt(px, py, count);
    if (cardIdx !== null && cardIdx < count) {
      this.toggleTracePanel(this.cardNames[cardIdx]);
      return;
    }
    const lineIdx = this.hud.feedLineIndexAt(px, py);
    if (lineIdx !== null) {
      const item = this.feedLineItems[lineIdx];
      if (item && item.type === "turn") this.toggleTracePanel(item.agentName);
    }
  }

  // -- SpaceCon command bar (single full-width top bar, design README §1) ------

  /**
   * Build the single SpaceCon command bar (replaces buildTopBar + buildBadgeRow):
   * a navy bar with a bottom border, a LEFT group (wordmark · transport · speed ·
   * mock/live) and a RIGHT group (clock · telemetry chips + BUDGET indicator).
   * All children are flat absolute-positioned rects + interactive Text (no
   * nested containers — Phaser 4.1 gotcha). The segment maps are repopulated.
   */
  private buildCommandBar(): void {
    const barH = this.hud.topbarH;
    const midY = Math.round(barH / 2);
    // Flat navy fill (a gradient is impractical in Phaser canvas; the README
    // permits a flat cmdGradTop fill) + a bottom border in borderControl.
    this.cmdBar = this.add
      .rectangle(0, 0, this.hud.w, barH, CMD_BAR_BG, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);
    this.add
      .rectangle(0, barH - 1, this.hud.w, 1, CMD_BORDER, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD);

    // -- LEFT group: wordmark → transport → speed → mock/live ----------------
    const padL = 14;
    let x = padL;

    // Wordmark: a small cyan dot + MADOW VALLEY in display 700 white.
    const dotR = 4;
    this.add
      .circle(x + dotR, midY, dotR, CMD_WORDMARK_DOT, 1)
      .setDepth(DEPTH_HUD_TEXT);
    const wordmark = this.add
      .text(x + dotR * 2 + 7, midY, "MADOW VALLEY", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        color: COLOR_TEXT,
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH_HUD_TEXT);
    x = Math.round(wordmark.x + wordmark.width + 16);

    // Transport segment: a rounded control container holding play/pause + step.
    {
      const seg = this.beginSegment(x, midY);
      const pause = this.makeSegButton(
        seg.x,
        midY,
        "⏸",
        PX_BASE,
        () => this.togglePause(),
      );
      this.pauseBtn = pause.label;
      this.pauseBtnBg = pause.bg;
      seg.advance(pause.w);
      const step = this.makeSegButton(seg.x, midY, "⏭", PX_BASE, () => {
        this.conn?.controls.step();
        this.renderTransportSegment();
      });
      seg.advance(step.w);
      x = this.endSegment(seg, midY);
    }
    x += 8;

    // Speed segment: ½ / 1× / 2× / 4×, mono ~12px; selected fills brand600.
    this.speedBtns.clear();
    this.speedBtnBgs.clear();
    {
      const seg = this.beginSegment(x, midY);
      for (const speed of SPEEDS) {
        const label = speed === 0.5 ? "½" : `${speed}×`;
        const b = this.makeSegButton(seg.x, midY, label, PX_SMALL, () => {
          this.conn?.controls.setSpeed(speed);
          this.renderSpeedSegment();
        }, MONO_FONT);
        this.speedBtns.set(speed, b.label);
        this.speedBtnBgs.set(speed, b.bg);
        seg.advance(b.w);
      }
      x = this.endSegment(seg, midY);
    }
    x += 8;

    // Mock / Live segment: two buttons reflecting the REAL killSwitch.state().
    this.modeBtns.clear();
    this.modeBtnBgs.clear();
    {
      const seg = this.beginSegment(x, midY);
      for (const mode of ["mock", "live"] as const) {
        const b = this.makeSegButton(
          seg.x,
          midY,
          mode.toUpperCase(),
          PX_SMALL,
          // Mock is env-gated/terminal; the runner mode is NOT toggled from the
          // HUD (no fabricated mock→live flip). Clicking re-asserts the segment.
          () => this.renderModeSegment(),
          MONO_FONT,
        );
        this.modeBtns.set(mode, b.label);
        this.modeBtnBgs.set(mode, b.bg);
        seg.advance(b.w);
      }
      x = this.endSegment(seg, midY);
    }

    // -- RIGHT group: clock + telemetry chips + BUDGET indicator -------------
    // Built from the right edge inward; renderCommandBar() positions the chips
    // because their widths depend on live text.
    // Clock: an amber phase glyph + the white "DAY n  PHASE" label. Two Text
    // objects so the glyph carries p2/amber per README without inline markup.
    this.clockGlyph = this.add
      .text(0, midY, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: CMD_PHASE_GLYPH,
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH_HUD_TEXT);
    this.clockText = this.add
      .text(0, midY, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: COLOR_TEXT,
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH_HUD_TEXT);

    const chip = (color: string): Phaser.GameObjects.Text =>
      this.add
        .text(0, midY, "", {
          fontFamily: MONO_FONT,
          fontSize: PX_SMALL,
          color,
          backgroundColor: `#${CMD_CONTROL_BG.toString(16).padStart(6, "0")}`,
          padding: { x: 8, y: 3 },
        })
        .setOrigin(1, 0.5)
        .setDepth(DEPTH_HUD_TEXT);
    this.inflightChip = chip(CMD_INFLIGHT);
    this.cogChip = chip(COLOR_DIM);
    this.costChip = chip(CMD_COST_OK);
    // BUDGET REACHED indicator folded into the bar (driven by budgetReached).
    this.budgetBadge = this.add
      .text(0, midY, "● BUDGET REACHED", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: p2.hex,
        padding: { x: 8, y: 3 },
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH_BADGE)
      .setVisible(false);

    this.renderCommandBar();
  }

  // -- segment helpers (rounded control container of seg buttons) -------------

  /** Begin a rounded SpaceCon control segment at left edge `x`. Buttons are
   *  placed left→right; endSegment() draws the container chrome behind them. */
  private beginSegment(x: number, _midY: number): {
    x: number;
    start: number;
    advance(w: number): void;
  } {
    const pad = 3;
    const inner = x + pad;
    return {
      x: inner,
      start: x,
      advance(w: number) {
        this.x = Math.round(this.x + w + 2);
      },
    };
  }

  /** Draw the rounded container chrome behind a built segment; returns the
   *  segment's right edge (for placing the next segment). */
  private endSegment(
    seg: { x: number; start: number },
    midY: number,
  ): number {
    const pad = 3;
    const right = seg.x - 2 + pad; // trim the trailing inter-button gap
    const w = right - seg.start;
    const h = FONT_SIZE_BASE + 12;
    const bg = this.add
      .rectangle(seg.start, midY, w, h, CMD_CONTROL_BG, 1)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, CMD_BORDER, 1)
      .setDepth(DEPTH_HUD);
    bg.setData("isSegmentChrome", true);
    // The container chrome sits BEHIND the buttons (which are at DEPTH_HUD_TEXT).
    return right;
  }

  /** A single segment button: an active-fill background rect (hidden until
   *  selected) under a label Text. Returns refs + the button's drawn width. */
  private makeSegButton(
    x: number,
    midY: number,
    label: string,
    size: string,
    onClick: () => void,
    fontFamily: string = HUD_FONT,
  ): {
    label: Phaser.GameObjects.Text;
    bg: Phaser.GameObjects.Rectangle;
    w: number;
  } {
    const padX = 8;
    const text = this.add
      .text(x + padX, midY, label, {
        fontFamily,
        fontSize: size,
        color: CMD_IDLE_FG,
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH_HUD_TEXT)
      .setInteractive({ useHandCursor: true });
    const w = Math.round(text.width + padX * 2);
    const h = FONT_SIZE_BASE + 8;
    // The active-fill sits ABOVE the segment container chrome (DEPTH_HUD) but
    // BELOW the label text (DEPTH_HUD_TEXT), so a selected button reads as a
    // filled pill behind its label.
    const bg = this.add
      .rectangle(x, midY, w, h, CMD_ACTIVE_BG, 1)
      .setOrigin(0, 0.5)
      .setDepth(DEPTH_HUD + 0.5)
      .setVisible(false);
    text.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, onClick);
    return { label: text, bg, w };
  }

  private togglePause(): void {
    const controls = this.conn?.controls;
    if (!controls) return;
    if (controls.isPaused()) controls.resume();
    else controls.pause();
    this.renderTransportSegment();
  }

  /** Re-render the whole command bar (transport, speed, mode, clock, telemetry,
   *  budget). Called by refreshAll() and on build. */
  private renderCommandBar(): void {
    if (this.destroyed || !this.cmdBar) return;
    this.renderTransportSegment();
    this.renderSpeedSegment();
    this.renderModeSegment();
    this.refreshClock();
    this.renderTelemetry();
  }

  /** Play/Pause toggle: the active (paused) fill — folds in the old PAUSED
   *  badge. The button shows ▶ to resume, ⏸ to pause. */
  private renderTransportSegment(): void {
    if (this.destroyed || !this.pauseBtn) return;
    const paused = this.conn?.controls.isPaused() ?? getTimeSystem().isPaused();
    this.pauseBtn.setText(paused ? "▶" : "⏸");
    // ACTIVE (paused) fills brand600 + white label; idle transparent ink300.
    this.pauseBtnBg.setVisible(paused);
    this.pauseBtn.setColor(paused ? CMD_ACTIVE_FG : CMD_IDLE_FG);
  }

  /** Speed segment: the selected multiplier fills brand600 white bold. */
  private renderSpeedSegment(): void {
    if (this.destroyed || this.speedBtns.size === 0) return;
    const speed = getTimeSystem().getSpeed();
    for (const [s, btn] of this.speedBtns) {
      const active = s === speed;
      this.speedBtnBgs.get(s)?.setVisible(active);
      btn.setColor(active ? CMD_ACTIVE_FG : CMD_IDLE_FG);
      btn.setFontStyle(active ? "bold" : "normal");
    }
  }

  /** Mock/Live segment — reflects the REAL runner mode from killSwitch.state().
   *  "mock" is terminal (env-gated) so MOCK renders selected when mock; in
   *  live/offline the LIVE button is selected. This is NOT a cosmetic toggle —
   *  kill-switch bus events (llm_offline/llm_recovered) re-render it. */
  private renderModeSegment(): void {
    if (this.destroyed || this.modeBtns.size === 0) return;
    const state = this.killSwitch.state();
    const live = state === "live" || state === "offline";
    const selected: "mock" | "live" = live ? "live" : "mock";
    for (const mode of ["mock", "live"] as const) {
      const active = mode === selected;
      this.modeBtnBgs.get(mode)?.setVisible(active);
      const btn = this.modeBtns.get(mode);
      if (!btn) continue;
      btn.setColor(active ? CMD_ACTIVE_FG : CMD_IDLE_FG);
      btn.setFontStyle(active ? "bold" : "normal");
    }
    // When live but the LLM dropped (offline), tint the LIVE label amber so the
    // kill-switch state is visible in the bar (rule 13 — the demo's thesis).
    if (state === "offline") this.modeBtns.get("live")?.setColor(p2.hex);
  }

  /** Clock: mono uppercase label + display day/phase (white) + phase glyph in
   *  amber. Reuses the time source feeding the old statusText. */
  private refreshClock(): void {
    if (this.destroyed || !this.clockText) return;
    const t = getTimeSystem().state();
    const icon = PHASE_ICON[t.phase] ?? "";
    // "☀ DAY 2 · MORNING" — amber glyph leads; the day/phase is white display.
    this.clockGlyph.setText(icon);
    this.clockText.setText(`DAY ${t.day} · ${t.phase.toUpperCase()}`);
    this.positionClock();
  }

  /** Position the clock block flush-right at the X left of the chip cluster.
   *  Called after the chips re-lay out (their widths shift the clock). */
  private positionClock(): void {
    if (!this.clockText) return;
    const clockRight = this.layoutRightGroup();
    const textX = Math.round(clockRight - this.clockText.width);
    this.clockText.setX(textX);
    this.clockGlyph.setX(Math.round(textX - 6));
  }

  /**
   * Telemetry chips — REAL data only:
   *  - in-flight: count of agents whose fsm === "THINKING".
   *  - cognition tally: the real metric the old cogMeter showed.
   *  - cost: $0.00 in mock (positive); in live, real cost is not tracked yet →
   *    honest "$—" placeholder (never a fabricated dollar figure).
   * Plus the BUDGET REACHED indicator. Re-lays the right group after updating.
   */
  private renderTelemetry(): void {
    if (this.destroyed || !this.inflightChip) return;
    const controls = this.conn?.controls;
    const agents = controls?.agents() ?? [];
    const thinking = agents.filter((a) => a.fsm === "THINKING").length;
    this.inflightChip.setText(`⟳ ${thinking}`);

    const metrics = controls?.cognitionMetrics?.() ?? null;
    this.cogChip.setText(formatCognitionMeter(metrics).text);

    // Cost: $0.00 in mock per README; in live, cost is NOT tracked yet → "$—".
    const mock = this.killSwitch.state() === "mock";
    this.costChip.setText(mock ? "$0.00" : "$—");
    this.costChip.setColor(mock ? CMD_COST_OK : CMD_LABEL);

    this.budgetBadge.setVisible(this.budgetReached);
    // chip widths just changed → re-place the clock left of the cluster.
    this.positionClock();
  }

  /**
   * Lay out the right group from the right edge inward: BUDGET (if shown) ·
   * cost · cognition · in-flight chips, then return the X where the clock's
   * right edge should sit (its left of the chip cluster). Integer pixels.
   */
  private layoutRightGroup(): number {
    const padR = 14;
    const gap = 8;
    let right = this.hud.w - padR;
    const place = (
      obj: Phaser.GameObjects.Text | undefined,
      visible: boolean,
    ): void => {
      if (!obj || !visible) return;
      obj.setX(Math.round(right));
      right = Math.round(right - obj.width - gap);
    };
    place(this.budgetBadge, this.budgetReached);
    place(this.costChip, true);
    place(this.cogChip, true);
    place(this.inflightChip, true);
    // The clock block ends just left of the chip cluster.
    return Math.round(right - 6);
  }

  // -- event feed ----------------------------------------------------------------

  /** Left inset (px) of a feed line's text past its color dot (README §5). */
  private static readonly FEED_DOT_INSET = 14;
  private static readonly FEED_DOT_R = 3;

  private buildFeedChrome(): void {
    this.add
      .rectangle(this.hud.logX, this.hud.logY, this.hud.logW, this.hud.logH, COLOR_CARD_BG, 0.96)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD);
    // Mono uppercase "EVENTS" header in the gutter just above the feed rect
    // (README §5) — a clear region marker without eating any feed-line space.
    this.add
      .text(this.hud.logX + this.hud.logPadX, this.hud.logY - FONT_SIZE_SMALL - 5, "EVENTS", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: COLOR_HEADER,
      })
      .setDepth(DEPTH_HUD_TEXT);
    const inset = UIScene.FEED_DOT_INSET;
    for (let i = 0; i < this.hud.logLines; i++) {
      const rowY = this.hud.logY + this.hud.logPadY + i * this.hud.logLineH;
      // Per-row colored dot (event-kind, from the feed line's view.color). Sits
      // at the row's left, vertically centered on the mono line.
      this.logDots.push(
        this.add
          .circle(
            this.hud.logX + this.hud.logPadX + UIScene.FEED_DOT_R,
            rowY + Math.round(FONT_SIZE_SMALL / 2),
            UIScene.FEED_DOT_R,
            COLOR_DIM_NUM,
            1,
          )
          .setDepth(DEPTH_HUD_TEXT)
          .setVisible(false),
      );
      this.logTexts.push(
        this.add
          .text(
            this.hud.logX + this.hud.logPadX + inset,
            rowY,
            "",
            {
              fontFamily: MONO_FONT,
              fontSize: PX_SMALL,
              color: COLOR_DIM,
            },
          )
          .setDepth(DEPTH_HUD_TEXT),
      );
      this.feedLineItems.push(null);
    }
  }

  private renderFeed(): void {
    const items = this.feed.list(this.hud.logLines); // newest-first
    for (let i = 0; i < this.hud.logLines; i++) {
      const line = this.logTexts[i];
      const dot = this.logDots[i];
      if (!line) continue;
      const item = items[i] ?? null;
      this.feedLineItems[i] = item;
      if (item) {
        const view = formatFeedItem(item, this.hud.logMaxChars);
        line.setText(view.text);
        line.setColor(toCssColor(view.color));
        line.setFontStyle(view.emphasis ? "bold" : "normal");
        // Dot encodes the event kind via the SAME color the line carries (the
        // feed's view.color derives from the EventLog kind→color map).
        dot?.setFillStyle(view.color, 1).setVisible(true);
      } else {
        if (line.text !== "") line.setText("");
        dot?.setVisible(false);
      }
    }
  }

  // -- Map-viewport overlay chips (B-4, design README §3) -------------------------

  /** Chip inner padding (README §3: ~5px×10px). */
  private static readonly CHIP_PAD_X = 10;
  private static readonly CHIP_PAD_Y = 5;
  /** Inset of the chips from the map rect's corners. */
  private static readonly CHIP_INSET = 10;

  /**
   * Build the two map-viewport overlay chips drawn OVER the map region (UIScene
   * owns HUD chrome + knows hud.mapRect):
   *  - a top-LEFT context chip (always shown): mono uppercase "MADOW VALLEY ·
   *    {W}×{H}" on a dark semi-opaque navy fill + control border.
   *  - a top-RIGHT follow chip (hidden until an agent is selected): "◎ Following
   *    · {name}" white on a brand-tinted semi-opaque fill + brand400 border.
   * Each chip is a Graphics (rounded fill + stroke) under a Text label. The
   * fill geometry follows the live text width, so renderMapOverlays() draws it
   * after measuring. No nested containers (Phaser 4.1 gotcha). Chip rects are
   * clamped to stay within hud.mapRect.
   */
  private buildMapOverlays(): void {
    this.ctxChipGfx = this.add.graphics().setDepth(DEPTH_HUD);
    this.ctxChipText = this.add
      .text(0, 0, "", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: CHIP_CTX_TEXT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT);
    this.followChipGfx = this.add.graphics().setDepth(DEPTH_HUD).setVisible(false);
    this.followChipText = this.add
      .text(0, 0, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: CHIP_FOLLOW_TEXT,
      })
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    this.renderMapOverlays();
  }

  /**
   * Draw / position the map-overlay chips. The context chip pins to the
   * top-left of hud.mapRect with the real MAP_WIDTH×MAP_HEIGHT; the follow chip
   * pins to the top-right and is shown only when an agent is selected. Both
   * chips' fills are sized to the measured text and clamped to stay within
   * hud.mapRect (defensive against the absolute-x-as-width class of bug).
   */
  private renderMapOverlays(): void {
    if (this.destroyed || !this.ctxChipGfx || !this.ctxChipText) return;
    const map = this.hud.mapRect;
    const padX = UIScene.CHIP_PAD_X;
    const padY = UIScene.CHIP_PAD_Y;
    const inset = UIScene.CHIP_INSET;

    // Helper: paint a rounded chip fill + border behind a measured label, and
    // return the chip's overall width (so callers can right-align). The label's
    // top-left is at (chipX + padX, chipY + padY). Chip width never exceeds the
    // map rect.
    const paintChip = (
      gfx: Phaser.GameObjects.Graphics,
      label: Phaser.GameObjects.Text,
      chipX: number,
      chipY: number,
      fill: number,
      fillAlpha: number,
      border: number,
    ): number => {
      const w = Math.min(map.w, Math.round(label.width + padX * 2));
      const h = Math.round(label.height + padY * 2);
      gfx.clear();
      gfx.fillStyle(fill, fillAlpha);
      gfx.fillRoundedRect(chipX, chipY, w, h, CHIP_RADIUS);
      gfx.lineStyle(1, border, 1);
      gfx.strokeRoundedRect(chipX, chipY, w, h, CHIP_RADIUS);
      label.setPosition(chipX + padX, chipY + padY);
      return w;
    };

    // -- Context chip (top-left, always shown). ------------------------------
    this.ctxChipText.setText(`MADOW VALLEY · ${MAP_WIDTH}×${MAP_HEIGHT}`);
    const ctxX = map.x + inset;
    const ctxY = map.y + inset;
    paintChip(
      this.ctxChipGfx,
      this.ctxChipText,
      ctxX,
      ctxY,
      CHIP_CTX_FILL,
      CHIP_CTX_ALPHA,
      CHIP_CTX_BORDER,
    );

    // -- Follow chip (top-right, only when an agent is selected). ------------
    if (!this.followChipGfx || !this.followChipText) return;
    if (this.selectedAgent) {
      this.followChipText.setText(`◎ Following · ${this.selectedAgent}`).setVisible(true);
      this.followChipGfx.setVisible(true);
      // Provisional width to compute the right-aligned X, then paint there.
      const w = Math.min(map.w, Math.round(this.followChipText.width + padX * 2));
      // Right-align inside the map rect; clamp so the chip never crosses the
      // left edge (a long name on a narrow map clamps flush-left).
      const fX = Math.max(map.x + inset, map.x + map.w - inset - w);
      const fY = map.y + inset;
      paintChip(
        this.followChipGfx,
        this.followChipText,
        fX,
        fY,
        CHIP_FOLLOW_FILL,
        CHIP_FOLLOW_ALPHA,
        CHIP_FOLLOW_BORDER,
      );
    } else {
      this.followChipGfx.clear();
      this.followChipGfx.setVisible(false);
      this.followChipText.setVisible(false);
    }
  }

  // -- KPI band (B-3, design README §2) -------------------------------------------

  /**
   * Build the five-tile KPI band chrome in the LEFT column, directly below the
   * command bar and above the map (hud.kpiBandRect). Each tile gets a `card`
   * backing rect with a `borderCard` border, a mono uppercase label (ink400)
   * and a display-700 value. Values are filled (with REAL sim data) by
   * renderKpiBand(); the labels are static. No nested containers.
   */
  private buildKpiBand(): void {
    // Static tile labels (design README §2). Order = tile index 0..4.
    const labels = [
      "AGENTS LIVE",
      "CONVERSATIONS",
      "AVG ENERGY",
      "ECONOMY",
      "DECISIONS",
    ];
    // Per-tile value color (design README §2): white · cyan300 · positive500 ·
    // white · white. All from theme tokens (single source).
    const valueColors = [
      COLOR_TEXT, // agents live — white
      COLOR_GOAL, // conversations — cyan300
      COLOR_OK, // avg energy — positive500
      COLOR_TEXT, // economy — white
      COLOR_TEXT, // decisions — white
    ];
    for (let i = 0; i < KPI_TILE_COUNT; i++) {
      const t = this.hud.kpiTileRect(i);
      this.kpiBg.push(
        this.add
          .rectangle(t.x, t.y, t.w, t.h, COLOR_CARD_BG, 1)
          .setOrigin(0, 0)
          .setStrokeStyle(1, COLOR_BORDER, 1)
          .setDepth(DEPTH_HUD),
      );
      // Mono uppercase label near the top of the tile (padding ~12×12).
      this.kpiLabels.push(
        this.add
          .text(t.x + 12, t.y + 8, labels[i], {
            fontFamily: MONO_FONT,
            fontSize: PX_KPI_LABEL,
            color: COLOR_HEADER, // ink400 (labels)
          })
          .setDepth(DEPTH_HUD_TEXT),
      );
      // Display-700 value below the label. Filled by renderKpiBand().
      this.kpiValues.push(
        this.add
          .text(t.x + 12, t.y + 24, "—", {
            fontFamily: HUD_FONT,
            fontSize: PX_KPI_VALUE,
            fontStyle: "bold",
            color: valueColors[i],
          })
          .setDepth(DEPTH_HUD_TEXT),
      );
    }
  }

  /**
   * Render the five KPI values from REAL sim data (no fabricated numbers):
   *   0 AGENTS LIVE   — living agents (a.alive !== false) count.
   *   1 CONVERSATIONS — active-conversation count from the SAME source the
   *                     transcript reads (latestConversation): 1 when one is
   *                     live, else 0. Honest — the HUD tracks one at a time.
   *   2 AVG ENERGY    — mean of agents' energy, as NN%. "—" when no agents.
   *   3 ECONOMY       — sum of agents' gold, "N,NNNg". (Design §2 wants a faint
   *                     trailing g; the 2-object split is deferred to a polish pass.)
   *   4 DECISIONS     — sum of agents' decisionsTotal.
   * Empty sources show an honest "0"/"—", never a fabricated number.
   * Event-driven via the markDirty()→refreshAll() throttle — not per-frame.
   */
  private renderKpiBand(): void {
    if (this.destroyed || this.kpiValues.length === 0) return;
    const agents = this.conn?.controls.agents() ?? [];
    // AGENTS LIVE — the real alive flag (undefined → counted as live).
    const live = agents.filter((a) => (a as { alive?: boolean }).alive !== false);
    // AVG ENERGY — mean over agents; "—" when there are none (honest empty).
    const energySum = agents.reduce((s, a) => s + (a.energy ?? 0), 0);
    const avgEnergy =
      agents.length > 0 ? formatPercent(energySum / agents.length) : "—";
    // ECONOMY — total gold across agents (rendered white; faint-g deferred).
    const goldSum = agents.reduce((s, a) => s + (a.gold ?? 0), 0);
    // DECISIONS — total decisions across agents.
    const decisionsSum = agents.reduce((s, a) => s + (a.decisionsTotal ?? 0), 0);
    // CONVERSATIONS — same source the transcript reads (latestConversation):
    // 1 when one is currently shown, else 0. The HUD tracks one at a time, so
    // this is the honest live count from that source (never invented).
    const conversations = this.latestConversation ? 1 : 0;

    this.kpiValues[0]?.setText(String(live.length));
    this.kpiValues[1]?.setText(String(conversations));
    this.kpiValues[2]?.setText(avgEnergy);
    // AVG ENERGY tile color follows the SAME energy-color rule as the cards —
    // the single cardStyle helper (design §4 thresholds). No agents → neutral.
    if (agents.length > 0) {
      const ratio = energySum / agents.length / 100;
      this.kpiValues[2]?.setColor(
        `#${energyLevelColor(ratio).toString(16).padStart(6, "0")}`,
      );
    } else {
      this.kpiValues[2]?.setColor(COLOR_DIM);
    }
    this.kpiValues[3]?.setText(formatEconomy(goldSum));
    this.kpiValues[4]?.setText(String(decisionsSum));
  }

  // -- Active-conversation card (right-rail DEFAULT state, README §5) -------------

  /** Card inner padding (README §5: ~16×17). */
  private static readonly ACV_PAD_X = 16;
  private static readonly ACV_PAD_Y = 13;

  /**
   * Build the standing Active-conversation card chrome at hud.activeConvRect:
   * a card surface + border, a mono uppercase header, a ★ + title + sub, three
   * inset mini-stat tiles (Know / Invited / Arrived), a compact governance line,
   * a pool of chat-thread bubbles (host left / other right), and an honest empty
   * state. Everything starts hidden; renderActiveConv() fills + shows what real
   * data supports. No nested containers (Phaser 4.1 gotcha).
   */
  private buildActiveConvChrome(): void {
    const r = this.hud.activeConvRect;
    const padX = UIScene.ACV_PAD_X;
    const padY = UIScene.ACV_PAD_Y;
    this.acvBg = this.add
      .rectangle(r.x, r.y, r.w, r.h, COLOR_CARD_BG, 0.96)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD)
      .setVisible(false);
    // Mono uppercase card header.
    this.acvHeader = this.add
      .text(r.x + padX, r.y + padY, "ACTIVE CONVERSATION", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: COLOR_HEADER,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    // ★ accent + title (gathering description / conversation participants).
    this.acvStar = this.add
      .text(r.x + padX, r.y + padY + 22, "★", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        color: COLOR_STAR,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    this.acvTitle = this.add
      .text(r.x + padX + 18, r.y + padY + 22, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        fontStyle: "bold",
        color: COLOR_TEXT,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    // "host {name} · day N {phase}" sub.
    this.acvSub = this.add
      .text(r.x + padX, r.y + padY + 44, "", {
        fontFamily: HUD_FONT_BODY,
        fontSize: PX_SMALL,
        color: COLOR_DIM,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    // Three inset mini-stat tiles. Geometry is set in renderActiveConv (it knows
    // the live card width); here we just create the pool. Value colors per
    // README §5: Know (white), Invited (brand400), Arrived (positive500).
    const tileValueColors = [COLOR_TEXT, COLOR_PLAN, COLOR_OK];
    for (let i = 0; i < 3; i++) {
      this.acvTileBgs.push(
        this.add
          .rectangle(r.x, r.y, 10, 10, COLOR_INSET, 1)
          .setOrigin(0, 0)
          .setStrokeStyle(1, COLOR_BORDER, 1)
          .setDepth(DEPTH_HUD + 0.5)
          .setVisible(false),
      );
      this.acvTileLabels.push(
        this.add
          .text(r.x, r.y, "", {
            fontFamily: MONO_FONT,
            fontSize: PX_SMALL,
            color: COLOR_HEADER,
          })
          .setDepth(DEPTH_HUD_TEXT)
          .setVisible(false),
      );
      this.acvTileValues.push(
        this.add
          .text(r.x, r.y, "", {
            fontFamily: HUD_FONT,
            fontSize: PX_BASE,
            fontStyle: "bold",
            color: tileValueColors[i],
          })
          .setDepth(DEPTH_HUD_TEXT)
          .setVisible(false),
      );
    }
    // Compact governance proposal line (⚖ ruleText · tally), folded into the card.
    this.acvGov = this.add
      .text(r.x + padX, r.y, "", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        color: COLOR_PLAN,
        wordWrap: { width: Math.max(20, r.w - 2 * padX) },
        lineSpacing: 1,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    // Chat-thread bubbles: a tinted rect + body text per line (host left / other
    // right). Geometry is reflowed each render; here we create the pool.
    for (let i = 0; i < UIScene.TRANSCRIPT_MAX_LINES; i++) {
      this.acvBubbleBgs.push(
        this.add
          .rectangle(r.x, r.y, 10, 10, COLOR_BUBBLE_HOST, 1)
          .setOrigin(0, 0)
          .setDepth(DEPTH_HUD + 0.5)
          .setVisible(false),
      );
      this.acvBubbleTexts.push(
        this.add
          .text(r.x, r.y, "", {
            fontFamily: HUD_FONT_BODY,
            fontSize: PX_SMALL,
            color: COLOR_TEXT,
            wordWrap: { width: Math.max(20, r.w - 2 * padX - 16) },
            lineSpacing: 2,
          })
          .setDepth(DEPTH_HUD_TEXT)
          .setVisible(false),
      );
    }
    // Honest empty state.
    this.acvEmpty = this.add
      .text(r.x + padX, r.y + padY + 44, "No active conversation", {
        fontFamily: HUD_FONT_BODY,
        fontSize: PX_SMALL,
        color: COLOR_FAINT,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
  }

  /**
   * Render the Active-conversation card from REAL sim data (no fabricated
   * threads or stats — the sim tracks ONE conversation at a time):
   *   - gathering stats from buildPartyPanel (when there is a showcase event),
   *   - the conversation thread from buildTranscript (the latest conversation),
   *   - a compact governance proposal line from buildGovernancePanel (when a
   *     town rule is up for a vote).
   * Title rule (honest): a live gathering titles the card with its description +
   * a "host …" sub; with no gathering but a live conversation, the participants
   * title it; with neither, a calm "No active conversation" empty state. Hidden
   * entirely while a trace panel is open (INSPECTOR state overlays this region).
   * Event-driven via the markDirty()→refreshAll() throttle — not per-frame.
   */
  private renderActiveConv(): void {
    if (this.destroyed || !this.acvBg) return;
    // INSPECTOR state owns this region — the trace panel overlays the card.
    if (this.selectedAgent) {
      this.setActiveConvVisible(false);
      return;
    }
    const controls = this.conn?.controls;
    const town = controls?.agents().length ?? 0;

    // -- Gathering stats (real, from buildPartyPanel) -------------------------
    const eventId = controls?.showcaseEventId?.() ?? null;
    const snap = eventId ? controls?.attendanceSnapshot?.(eventId) : undefined;
    const party = snap
      ? buildPartyPanel(
          snap,
          (eventId && this.arrivedByEvent.get(eventId)) || new Set<string>(),
          town,
        )
      : null;

    // -- Conversation thread (real, from buildTranscript) ---------------------
    const conv = buildTranscript(
      this.latestConversation,
      UIScene.TRANSCRIPT_MAX_LINES,
      240,
    );
    const hasConv = !conv.empty;

    // -- Governance proposal (real, from buildGovernancePanel) ----------------
    const tally = controls?.governanceTally?.();
    const gov = tally ? buildGovernancePanel(tally, town) : null;

    // Neither a gathering nor a conversation → honest calm empty state.
    if (!party && !hasConv) {
      this.layoutActiveConvEmpty(gov);
      return;
    }

    const r = this.hud.activeConvRect;
    const padX = UIScene.ACV_PAD_X;
    const padY = UIScene.ACV_PAD_Y;
    const [p0, p1] = conv.participants;

    // Title + sub: a live gathering wins the title; otherwise the conversation
    // participants title the card (honest — no invented gathering).
    if (party) {
      this.acvTitle?.setText(this.clip(party.description, 32));
      this.acvSub?.setText(
        this.clip(
          `host ${party.host} · day ${snap?.event.day ?? "?"} ${snap?.event.phase ?? ""}`.trim(),
          40,
        ),
      );
    } else {
      this.acvTitle?.setText(this.clip(`${p0 ?? ""}${p1 ? ` ↔ ${p1}` : ""}`, 32));
      this.acvSub?.setText("conversation in progress");
    }
    this.acvStar?.setVisible(true);
    this.acvTitle?.setVisible(true);
    this.acvSub?.setVisible(true);
    this.acvEmpty?.setVisible(false);

    // Mini-stat tiles: shown ONLY when there is a real gathering (the stats come
    // from buildPartyPanel). With a bare conversation we honestly omit them
    // rather than invent zeros.
    let y = r.y + padY + 66;
    if (party) {
      y = this.layoutStatTiles(r, padX, y, party);
    } else {
      for (let i = 0; i < 3; i++) {
        this.acvTileBgs[i]?.setVisible(false);
        this.acvTileLabels[i]?.setVisible(false);
        this.acvTileValues[i]?.setVisible(false);
      }
    }

    // Compact governance line, folded in just below the stats when a tally open.
    y = this.layoutGovLine(r, padX, y, gov);

    // Chat thread (the real conversation turns), reflowed as alternating bubbles.
    this.layoutThread(r, padX, y, conv.lines, p0);

    this.setActiveConvVisible(true);
  }

  /** Lay out the empty/near-empty card: a calm "No active conversation" line,
   *  plus the governance proposal line if a town rule is up for a vote (so the
   *  governance display is never lost even with no gathering/conversation). */
  private layoutActiveConvEmpty(gov: GovernancePanelView | null): void {
    const r = this.hud.activeConvRect;
    const padX = UIScene.ACV_PAD_X;
    const padY = UIScene.ACV_PAD_Y;
    this.acvStar?.setVisible(false);
    this.acvTitle?.setVisible(false);
    this.acvSub?.setVisible(false);
    for (let i = 0; i < 3; i++) {
      this.acvTileBgs[i]?.setVisible(false);
      this.acvTileLabels[i]?.setVisible(false);
      this.acvTileValues[i]?.setVisible(false);
    }
    for (let i = 0; i < this.acvBubbleBgs.length; i++) {
      this.acvBubbleBgs[i]?.setVisible(false);
      this.acvBubbleTexts[i]?.setVisible(false);
    }
    this.acvEmpty?.setY(r.y + padY + 22).setVisible(true);
    this.layoutGovLine(r, padX, r.y + padY + 48, gov);
    this.setActiveConvVisible(true);
  }

  /** Lay out the three inset mini-stat tiles (Know N/M · Invited K · Arrived J)
   *  from the real party view; returns the y just below the tile row. */
  private layoutStatTiles(
    r: { x: number; y: number; w: number; h: number },
    padX: number,
    top: number,
    party: PartyPanelView,
  ): number {
    const gap = 8;
    const innerW = r.w - 2 * padX;
    const tileW = Math.floor((innerW - 2 * gap) / 3);
    const tileH = 38;
    const labels = ["KNOW", "INVITED", "ARRIVED"];
    const values = [
      party.knowLine.replace(/\s*know$/i, ""), // "N/M"
      String(party.invitedCount),
      String(party.arrivedCount),
    ];
    for (let i = 0; i < 3; i++) {
      const tx = r.x + padX + i * (tileW + gap);
      this.acvTileBgs[i]
        ?.setPosition(tx, top)
        .setSize(tileW, tileH)
        .setVisible(true);
      this.acvTileLabels[i]
        ?.setPosition(tx + 8, top + 6)
        .setText(labels[i])
        .setVisible(true);
      this.acvTileValues[i]
        ?.setPosition(tx + 8, top + 18)
        .setText(values[i])
        .setVisible(true);
    }
    return top + tileH + 10;
  }

  /** Lay out the compact governance proposal line (⚖ ruleText · Yes/No · aware)
   *  when a town rule is up for a vote; returns the y below it (unchanged when
   *  there is no proposal). PRESERVES the governance display per the contract. */
  private layoutGovLine(
    r: { x: number; y: number; w: number; h: number },
    padX: number,
    top: number,
    gov: GovernancePanelView | null,
  ): number {
    if (!gov) {
      this.acvGov?.setVisible(false);
      return top;
    }
    const verb =
      gov.status === "adopted"
        ? "ADOPTED"
        : gov.status === "rejected"
          ? "REJECTED"
          : "up for a vote";
    this.acvGov
      ?.setPosition(r.x + padX, top)
      .setText(this.clip(`⚖ ${gov.ruleText} · ${gov.tallyLine} · ${verb}`, 88))
      .setVisible(true);
    return top + (this.acvGov?.height ?? 0) + 8;
  }

  /** Reflow the conversation turns as alternating chat bubbles: host (p0) left-
   *  aligned bubbleHost tint, the other speaker right-aligned bubbleGuest tint,
   *  max-width ~88%. Rows that would spill past the card bottom are hidden. */
  private layoutThread(
    r: { x: number; y: number; w: number; h: number },
    padX: number,
    top: number,
    lines: ReadonlyArray<{ speaker: string; text: string }>,
    host: string,
  ): void {
    const innerW = r.w - 2 * padX;
    const maxBubbleW = Math.floor(innerW * 0.88);
    const textPad = 8;
    const bottom = r.y + r.h - 6;
    let y = top;
    for (let i = 0; i < this.acvBubbleTexts.length; i++) {
      const bubble = this.acvBubbleBgs[i];
      const txt = this.acvBubbleTexts[i];
      const line = lines[i];
      if (!bubble || !txt) continue;
      if (line && y < bottom) {
        const isHost = line.speaker === host;
        txt.setWordWrapWidth(Math.max(20, maxBubbleW - 2 * textPad));
        txt.setText(this.clip(line.text, 240));
        const bw = Math.min(maxBubbleW, Math.ceil(txt.width) + 2 * textPad);
        const bh = Math.ceil(txt.height) + 2 * textPad;
        const bx = isHost ? r.x + padX : r.x + r.w - padX - bw;
        bubble
          .setPosition(bx, Math.round(y))
          .setSize(bw, bh)
          .setFillStyle(isHost ? COLOR_BUBBLE_HOST : COLOR_BUBBLE_GUEST, 1)
          .setVisible(true);
        txt.setPosition(bx + textPad, Math.round(y) + textPad).setVisible(true);
        y += bh + 5;
      } else {
        if (txt.text !== "") txt.setText("");
        bubble.setVisible(false);
        txt.setVisible(false);
      }
    }
  }

  private setActiveConvVisible(visible: boolean): void {
    this.acvVisible = visible;
    this.acvBg?.setVisible(visible);
    this.acvHeader?.setVisible(visible);
    if (!visible) {
      this.acvStar?.setVisible(false);
      this.acvTitle?.setVisible(false);
      this.acvSub?.setVisible(false);
      this.acvEmpty?.setVisible(false);
      this.acvGov?.setVisible(false);
      for (let i = 0; i < 3; i++) {
        this.acvTileBgs[i]?.setVisible(false);
        this.acvTileLabels[i]?.setVisible(false);
        this.acvTileValues[i]?.setVisible(false);
      }
      for (let i = 0; i < this.acvBubbleBgs.length; i++) {
        this.acvBubbleBgs[i]?.setVisible(false);
        this.acvBubbleTexts[i]?.setVisible(false);
      }
    }
    // Keep the click-through guard in sync with what's actually drawn.
    this.publishPanelRect();
  }

  // -- agent cards ----------------------------------------------------------------

  private renderCards(): void {
    const agents = this.conn?.controls.agents() ?? [];
    // The bottom strip shows full agent cards in a single row that SCROLLS
    // horizontally, so every agent's card is reachable (wheel over the strip, or
    // the ◀ ▶ buttons). `cardScroll` is the first agent in the visible window.
    const total = agents.length;
    const perPage = this.hud.cardsPerPage();
    const maxScroll = Math.max(0, total - perPage);
    this.cardScroll = Math.max(0, Math.min(this.cardScroll, maxScroll));
    const start = this.cardScroll;
    const windowed = agents.slice(start, start + perPage);

    const layoutKey = `${total}/${start}/${perPage}:${windowed.map((a) => a.name).join(",")}`;
    if (layoutKey !== this.cardLayoutKey) {
      this.destroyCards();
      this.cardLayoutKey = layoutKey;
      this.cardNames = windowed.map((a) => a.name);
      for (let slot = 0; slot < windowed.length; slot++) {
        const rect = this.hud.cardRect(slot, windowed.length);
        this.cards.set(windowed[slot].name, this.createCard(rect.x, rect.y, rect.h));
      }
    }
    for (const agent of windowed) {
      const ui = this.cards.get(agent.name);
      if (ui) this.updateCard(ui, buildAgentCard(agent));
    }
    // Header: total count + which window is shown, plus a scroll affordance.
    if (this.agentsHeader) {
      if (total === 0) {
        this.agentsHeader.setText("AGENTS");
      } else if (total <= perPage) {
        this.agentsHeader.setText(`AGENTS · ${total}`);
      } else {
        const lo = start + 1;
        const hi = Math.min(total, start + windowed.length);
        const left = start > 0 ? "◀" : "·";
        const right = start < maxScroll ? "▶" : "·";
        this.agentsHeader.setText(
          `AGENTS · ${total}   ${left} ${lo}–${hi} ${right}   (scroll)`,
        );
      }
    }
  }

  /** Scroll the agent strip by `delta` cards (clamped); re-renders the window. */
  private scrollCards(delta: number): void {
    const total = this.conn?.controls.agents().length ?? 0;
    const maxScroll = Math.max(0, total - this.hud.cardsPerPage());
    const next = Math.max(0, Math.min(this.cardScroll + delta, maxScroll));
    if (next === this.cardScroll) return;
    this.cardScroll = next;
    this.renderCards();
  }

  private destroyCards(): void {
    for (const ui of this.cards.values()) {
      for (const obj of Object.values(ui)) {
        // `name` is a plain string tag (not a game object) — skip it.
        if (typeof obj === "string") continue;
        (obj as Phaser.GameObjects.GameObject | null)?.destroy();
      }
    }
    this.cards.clear();
    this.cardNames = [];
  }

  /**
   * COMPACT bottom-strip card. Flat absolute-positioned children (no containers —
   * Phaser 4.1 gotcha) laid out in a fixed vertical stack inside a ~246×162 card:
   * header (swatch + name·role + FSM), a gold/energy row with the progress bar,
   * plan, goal, the intrinsic-drive needs row, one thought line, action, the top
   * relationship row, and the meta row. The full decision trace / persona opens
   * on click via the right-panel trace panel. The strip SCROLLS horizontally
   * (cardScroll) so every agent's card is reachable.
   */
  private createCard(x: number, y: number, cardH: number): CardUi {
    const cardW = this.hud.cardW;
    const padX = 14; // design §4: padding 13×14
    const padTop = 13;
    const text = (
      tx: number,
      ty: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add.text(tx, ty, "", style).setDepth(DEPTH_HUD_TEXT);

    // Card surface — idle style by default; updateCard swaps to the selected
    // style (cardSelected bg + brand500 border) when this card's agent is the
    // selected one. Tokens only (theme.ts single source).
    const bg = this.add
      .rectangle(x, y, cardW, cardH, cardSurface.num, 0.97)
      .setOrigin(0, 0)
      .setStrokeStyle(1, borderCard.num, 1)
      .setDepth(DEPTH_HUD);

    // -- Header row: 11px swatch + name + right-aligned state badge -----------
    const headerY = y + padTop;
    const swatch = this.add
      .rectangle(x + padX, headerY + 2, 11, 11, white.num, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT);

    // State-badge pill (tinted fill) pinned to the card's right edge; its label
    // is right-aligned over it. Sized to fit the longest label ("EXECUTING").
    const badgeW = 70;
    const badgeH = 16;
    const badgeRight = x + cardW - padX;
    const badgeBg = this.add
      .rectangle(badgeRight, headerY, badgeW, badgeH, tintIdle.color, tintIdle.alpha)
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT);
    const badge = text(badgeRight - 6, headerY + 3, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: ink400.hex,
      fontStyle: "bold",
    }).setOrigin(1, 0);

    const nameText = text(x + padX + 16, headerY, {
      fontFamily: HUD_FONT,
      fontSize: PX_BASE,
      color: white.hex,
      fontStyle: "bold",
    });

    // -- Stats row: gold (amber mono) + energy bar + E{n} --------------------
    const statsY = headerY + 27;
    const gold = text(x + padX, statsY, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: p2.hex,
    });
    // Energy bar (6px track, divider fill) sits between the gold and the E{n}
    // readout. The E{n} label is right-aligned at the card edge.
    const energyText = text(x + cardW - padX, statsY, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: ink400.hex,
    }).setOrigin(1, 0);
    const barRight = x + cardW - padX - 36;
    const barLeft = x + padX + 56;
    const barW = Math.max(20, barRight - barLeft);
    const barY = statsY + 6;
    const energyBg = this.add
      .rectangle(barLeft, barY, barW, 6, divider.num, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT);
    const energyFill = this.add
      .rectangle(barLeft, barY, barW, 6, positive500.num, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT);

    // -- Goal (body copy, ink300) --------------------------------------------
    const goalY = statsY + 22;
    const goal = text(x + padX, goalY, {
      fontFamily: HUD_FONT_BODY,
      fontSize: PX_SMALL,
      color: ink300.hex,
      wordWrap: { width: Math.max(20, cardW - 2 * padX) },
    });

    // -- Action row: verb-colored verb + green ✓ -----------------------------
    const actionY = goalY + 36;
    const action = text(x + padX, actionY, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: brand400.hex,
    });
    const check = text(x + cardW - padX, actionY, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: positive500.hex,
    }).setOrigin(1, 0);

    // -- Thought quote: top divider + italic body, curly-quoted --------------
    const ruleY = actionY + 22;
    const thoughtRule = this.add
      .rectangle(x + padX, ruleY, cardW - 2 * padX, 1, divider.num, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_HUD_TEXT);
    const thought = text(x + padX, ruleY + 8, {
      fontFamily: HUD_FONT_BODY,
      fontSize: PX_SMALL,
      fontStyle: "italic",
      color: ink400.hex,
      wordWrap: { width: Math.max(20, cardW - 2 * padX) },
    });

    return {
      name: "",
      bg,
      swatch,
      nameText,
      badgeBg,
      badge,
      gold,
      energyBg,
      energyFill,
      energyText,
      goal,
      action,
      check,
      thoughtRule,
      thought,
    };
  }

  private updateCard(ui: CardUi, card: ObsAgentCardModel): void {
    ui.name = card.name;
    if (typeof card.color === "number") ui.swatch.setFillStyle(card.color, 1);

    // Selected-card style: when this card's agent is the selected one, swap to
    // the cardSelected surface + a brand500 ring (purely additive — clicking
    // still toggles the trace panel). Tokens only.
    const selected = this.selectedAgent === card.name;
    ui.bg.setFillStyle(selected ? cardSelected.num : cardSurface.num, 0.97);
    ui.bg.setStrokeStyle(1, selected ? brand500.num : borderCard.num, 1);

    // Wave 4a — append the derived role to the name only when non-default.
    const roleTag = card.role && card.role !== "farmer" ? ` · ${card.role}` : "";
    // Clip the name short so the right-aligned state badge never collides.
    ui.nameText.setText(this.clip(`${card.name}${roleTag}`, 17));

    // State badge (design §4) — label + text color + tint pill, from the pure
    // helper so the rule lives in one place.
    const b = stateBadge(card.fsm);
    ui.badge.setText(b.label).setColor(`#${b.color.toString(16).padStart(6, "0")}`);
    ui.badgeBg.setFillStyle(b.tint.color, b.tint.alpha);

    ui.gold.setText(`${card.gold}g`);
    this.updateEnergy(ui, card.energy);

    ui.goal.setText(this.clip(card.goal ?? "—", 64));

    // Action row: the verb is colored BY VERB (helper); a trailing green ✓ marks
    // a successful action (✗ + red marks a failure). The full reason text lives
    // in the trace panel — the card face stays clean.
    if (card.lastAction) {
      const { action, ok } = card.lastAction;
      ui.action.setText(this.clip(action, 26)).setColor(
        `#${actionVerbColor(action).toString(16).padStart(6, "0")}`,
      );
      ui.check.setText(ok ? "✓" : "✗").setColor(ok ? positive500.hex : p1.hex);
    } else {
      ui.action.setText("—").setColor(ink500.hex);
      ui.check.setText("");
    }

    // Thought quote — curly-quoted, italic; "…" when the agent has no last
    // thought yet (honest empty, never fabricated).
    ui.thought.setText(card.lastThought ? `“${this.clip(card.lastThought, 30)}”` : "…");
  }

  private updateEnergy(ui: CardUi, energy: number): void {
    const ratio = Phaser.Math.Clamp(energy, 0, 100) / 100;
    const fullW = ui.energyBg.width;
    ui.energyFill.setSize(Math.max(1, Math.round(fullW * ratio)), 6);
    // The ONE energy-color source: the cardStyle helper (design §4 thresholds
    // >55% / >25%). The KPI band + command bar read the same helper.
    ui.energyFill.setFillStyle(energyLevelColor(ratio));
    ui.energyText.setText(`E${Math.round(energy)}`);
  }

  private clip(text: string, maxChars: number): string {
    const flat = text.replace(/\s+/g, " ");
    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  }

  // -- INSPECTOR rail (right-rail INSPECTOR state, README §6) ------------------

  /** Inspector card inner padding. */
  private static readonly INSP_PAD_X = 16;
  private static readonly INSP_PAD_Y = 14;

  private toggleTracePanel(name: string): void {
    if (this.selectedAgent === name) {
      this.closePanel();
      return;
    }
    this.closePanel();
    this.selectedAgent = name;
    this.traceScroll = 0;
    this.buildPanelChrome(name);
    this.rebuildPanelEntries();
    this.renderActiveConv(); // hide the Active-conversation card behind the open panel
    this.publishPanelRect();
    this.publishSelected(); // B-4: WorldScene follows + rings the selected agent
    this.renderMapOverlays(); // show the follow chip
  }

  /**
   * Build the fixed inspector chrome (README §6): the tall card surface +
   * #2f4a6b inspector border, the header (color swatch · name · persona sub ·
   * state badge · close ✕ control), and the three-tile stat strip (Gold /
   * Energy / Decisions). These never scroll; the trace timeline + model strip +
   * memory stream below them are the scrollable content (rebuildPanelEntries).
   * No nested containers (Phaser 4.1 gotcha); reads REAL card data.
   */
  private buildPanelChrome(name: string): void {
    const x = this.hud.panelX;
    const y = this.hud.panelY;
    const w = this.hud.panelW;
    const h = this.hud.panelH;
    const padX = UIScene.INSP_PAD_X;
    const padY = UIScene.INSP_PAD_Y;
    const objs: Phaser.GameObjects.GameObject[] = [];

    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    const card = agent ? buildAgentCard(agent) : null;

    // Card surface + the distinctive inspector border (#2f4a6b).
    const bg = this.add
      .rectangle(x, y, w, h, COLOR_CARD_BG, 0.96)
      .setOrigin(0, 0)
      .setStrokeStyle(1, INSP_BORDER, 1)
      .setDepth(DEPTH_PANEL);
    objs.push(bg);

    // -- Header: swatch · name · persona · state badge · close ✕ -------------
    const swatch = this.add
      .rectangle(x + padX, y + padY + 2, 13, 13, card?.color ?? COLOR_DIM_NUM, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH_PANEL + 1);
    objs.push(swatch);
    const nameText = this.add
      .text(x + padX + 20, y + padY - 2, this.clip(name, 22), {
        fontFamily: HUD_FONT,
        fontSize: PX_TITLE,
        fontStyle: "bold",
        color: COLOR_TEXT,
      })
      .setDepth(DEPTH_PANEL + 1);
    objs.push(nameText);
    const persona = this.add
      .text(
        x + padX + 20,
        y + padY + 20,
        this.clip(agent ? personaText(agent.persona) : "", 44),
        { fontFamily: HUD_FONT_BODY, fontSize: PX_SMALL, color: INSP_PERSONA },
      )
      .setDepth(DEPTH_PANEL + 1);
    objs.push(persona);

    // Close ✕ control — a 26×26 control-bg button (border #24324d), aligned to
    // the published panelCloseRect so the scene-level hit test lands on it.
    const closeBtnX = x + w - padX - 26;
    const closeBg = this.add
      .rectangle(closeBtnX, y + padY - 2, 26, 26, INSP_CTRL_BG, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, INSP_CTRL_BORDER, 1)
      .setDepth(DEPTH_PANEL + 1);
    objs.push(closeBg);
    const close = this.add
      .text(closeBtnX + 13, y + padY + 11, "✕", {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: COLOR_DIM,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTH_PANEL + 2);
    objs.push(close);

    // State badge pill (FSM), to the left of the close control.
    const badge = stateBadge(card?.fsm ?? "IDLE");
    const badgeText = this.add
      .text(0, 0, badge.label, {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: `#${badge.color.toString(16).padStart(6, "0")}`,
      })
      .setDepth(DEPTH_PANEL + 2);
    const badgeW = Math.ceil(badgeText.width) + 12;
    const badgeH = Math.ceil(badgeText.height) + 6;
    const badgeX = closeBtnX - 8 - badgeW;
    const badgeBg = this.add
      .rectangle(badgeX, y + padY, badgeW, badgeH, badge.tint.color, badge.tint.alpha)
      .setOrigin(0, 0)
      .setDepth(DEPTH_PANEL + 1);
    badgeText.setPosition(badgeX + 6, y + padY + 3);
    objs.push(badgeBg, badgeText);

    // -- Stat strip: Gold / Energy / Decisions inset mini tiles --------------
    const stripTop = y + padY + 44;
    const gap = 8;
    const innerW = w - 2 * padX;
    const tileW = Math.floor((innerW - 2 * gap) / 3);
    const tileH = 40;
    const energyRatio = (card?.energy ?? 0) / 100;
    const stats: { label: string; value: string; color: string }[] = [
      { label: "GOLD", value: String(card?.gold ?? 0), color: p2.hex },
      {
        label: "ENERGY",
        value: `${Math.round(card?.energy ?? 0)}`,
        color: `#${energyLevelColor(energyRatio).toString(16).padStart(6, "0")}`,
      },
      { label: "DECISIONS", value: String(card?.decisionsTotal ?? 0), color: COLOR_TEXT },
    ];
    for (let i = 0; i < 3; i++) {
      const tx = x + padX + i * (tileW + gap);
      objs.push(
        this.add
          .rectangle(tx, stripTop, tileW, tileH, COLOR_INSET, 1)
          .setOrigin(0, 0)
          .setStrokeStyle(1, COLOR_BORDER, 1)
          .setDepth(DEPTH_PANEL + 1),
      );
      objs.push(
        this.add
          .text(tx + 8, stripTop + 6, stats[i].label, {
            fontFamily: MONO_FONT,
            fontSize: PX_SMALL,
            color: COLOR_HEADER,
          })
          .setDepth(DEPTH_PANEL + 2),
      );
      objs.push(
        this.add
          .text(tx + 8, stripTop + 19, stats[i].value, {
            fontFamily: HUD_FONT,
            fontSize: PX_BASE,
            fontStyle: "bold",
            color: stats[i].color,
          })
          .setDepth(DEPTH_PANEL + 2),
      );
    }

    this.panelContentTop = stripTop + tileH + 12;
    this.panelObjects = objs;
  }

  private closePanel(): void {
    this.selectedAgent = null;
    for (const obj of this.panelEntryTexts) obj.destroy();
    this.panelEntryTexts = [];
    this.panelContent = [];
    for (const obj of this.panelObjects) obj.destroy();
    this.panelObjects = [];
    this.renderActiveConv(); // restore the Active-conversation card once the panel closes
    this.publishPanelRect();
    this.publishSelected(); // B-4: clear the selection → WorldScene drops follow + ring
    this.renderMapOverlays(); // hide the follow chip
  }

  /** B-4: publish the selected agent NAME (or null) to the registry so
   *  WorldScene can camera-follow + pulse-ring it. Additive to REG_HUD. */
  private publishSelected(): void {
    this.registry.set(REG_SELECTED, this.selectedAgent);
  }

  /**
   * Build the scrollable inspector content below the stat strip: the four-node
   * decision-trace timeline (Observation → Thought → Action → Result), the
   * model/cost strip, and the memory stream. All projections come from the pure
   * inspectorRail helpers (honest Result, no fabricated cost) + the additive
   * memoryStream seam (REAL memory entries, honest empty state). Each object's
   * base-Y is recorded so layoutPanel() can apply the wheel scroll.
   */
  private rebuildPanelEntries(): void {
    const name = this.selectedAgent;
    if (!name) return;
    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    for (const obj of this.panelEntryTexts) obj.destroy();
    this.panelEntryTexts = [];
    this.panelContent = [];
    if (!agent) return;

    const x = this.hud.panelX;
    const w = this.hud.panelW;
    const padX = UIScene.INSP_PAD_X;
    const card = buildAgentCard(agent);
    const textW = Math.max(40, w - 2 * padX - 18); // 18px gutter for node dots / chips
    let y = this.panelContentTop;

    const push = (
      obj: Phaser.GameObjects.GameObject & {
        setY(v: number): unknown;
        setVisible(v: boolean): unknown;
      },
      h: number,
    ): void => {
      this.panelContent.push({ obj, baseY: y, h });
      this.panelEntryTexts.push(obj);
    };

    // -- Decision-trace timeline (4 colored nodes + connector) ----------------
    const nodes = traceNodes({
      trace: card.trace,
      lastThought: card.lastThought,
      lastAction: card.lastAction,
    });
    const dotX = x + padX + 4;
    const labelX = x + padX + 18;
    for (let i = 0; i < nodes.length; i++) {
      const node: TraceNode = nodes[i];
      const labelText = this.add
        .text(labelX, y, node.label, {
          fontFamily: MONO_FONT,
          fontSize: PX_SMALL,
          fontStyle: "bold",
          color: `#${node.labelColor.toString(16).padStart(6, "0")}`,
        })
        .setDepth(DEPTH_PANEL + 2);
      const labelH = Math.ceil(labelText.height);
      const body = this.add
        .text(labelX, y + labelH + 1, node.text, {
          fontFamily: node.italic ? HUD_FONT_BODY : MONO_FONT,
          fontSize: PX_SMALL,
          fontStyle: node.italic ? "italic" : "normal",
          color: `#${node.textColor.toString(16).padStart(6, "0")}`,
          wordWrap: { width: textW, useAdvancedWrap: true },
        })
        .setDepth(DEPTH_PANEL + 2);
      const bodyH = Math.ceil(body.height);
      const nodeBlockH = labelH + 1 + bodyH + 10;
      // Node dot.
      const dot = this.add
        .rectangle(dotX, y + 2, 7, 7, node.nodeColor, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_PANEL + 2);
      // Connector below the dot toward the next node.
      if (i < nodes.length - 1) {
        const conn = this.add
          .rectangle(dotX + 3, y + 10, 1, nodeBlockH - 4, INSP_CONNECTOR, 1)
          .setOrigin(0, 0)
          .setDepth(DEPTH_PANEL + 1);
        push(conn, 0); // zero-height: rides the node block, not its own row
      }
      push(dot, 0);
      push(labelText, 0);
      push(body, nodeBlockH);
      y += nodeBlockH;
    }

    // -- Model/cost strip (model · latency · tokens; NO dollar cost) ----------
    y += 4;
    const strip = modelStrip(card);
    const stripText = this.add
      .text(x + padX + 8, y + 6, strip.text, {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        color: strip.live ? INSP_MODEL_LIVE : INSP_MODEL_MOCK,
      })
      .setDepth(DEPTH_PANEL + 2);
    const stripH = Math.ceil(stripText.height) + 12;
    const stripBg = this.add
      .rectangle(x + padX, y, w - 2 * padX, stripH, COLOR_INSET, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, INSP_CTRL_BORDER, 1)
      .setDepth(DEPTH_PANEL + 1);
    push(stripBg, 0);
    push(stripText, stripH + 12);
    y += stripH + 12;

    // -- Memory stream (tag chip + text + importance; from the real seam) -----
    const memHeader = this.add
      .text(x + padX, y, "MEMORY STREAM", {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: COLOR_HEADER,
      })
      .setDepth(DEPTH_PANEL + 2);
    push(memHeader, Math.ceil(memHeader.height) + 8);
    y += Math.ceil(memHeader.height) + 8;

    const memories = orderMemoryStream(
      this.conn?.controls.memoryStream?.(name) ?? [],
    );
    if (memories.length === 0) {
      const empty = this.add
        .text(x + padX, y, "No memories yet", {
          fontFamily: HUD_FONT_BODY,
          fontSize: PX_SMALL,
          color: COLOR_FAINT,
        })
        .setDepth(DEPTH_PANEL + 2);
      push(empty, Math.ceil(empty.height) + 6);
      y += Math.ceil(empty.height) + 6;
    } else {
      const chipX = x + padX;
      const chipW = 52;
      const memTextX = chipX + chipW + 8;
      const impW = 22;
      // memTextW is a panel-RELATIVE width: from the chip+gap to the inner
      // right edge, minus the importance column. (memTextX is an ABSOLUTE x,
      // so it must NOT be subtracted from the panel width `w`.)
      const memTextW = Math.max(40, w - 2 * padX - chipW - 8 - impW - 6);
      for (const m of memories) {
        const chip = memoryTagChip(m.type);
        const bodyText = this.add
          .text(memTextX, y, this.clip(m.text, 120), {
            fontFamily: HUD_FONT_BODY,
            fontSize: PX_SMALL,
            color: COLOR_DIM,
            wordWrap: { width: memTextW, useAdvancedWrap: true },
          })
          .setDepth(DEPTH_PANEL + 2);
        const rowH = Math.max(18, Math.ceil(bodyText.height)) + 8;
        const chipBg = this.add
          .rectangle(chipX, y, chipW, 16, chip.fill.color, chip.fill.alpha)
          .setOrigin(0, 0)
          .setDepth(DEPTH_PANEL + 1);
        const chipLabel = this.add
          .text(chipX + chipW / 2, y + 8, chip.label, {
            fontFamily: MONO_FONT,
            fontSize: PX_SMALL,
            fontStyle: "bold",
            color: `#${chip.color.toString(16).padStart(6, "0")}`,
          })
          .setOrigin(0.5, 0.5)
          .setDepth(DEPTH_PANEL + 2);
        const imp = this.add
          .text(x + w - padX, y, String(m.importance), {
            fontFamily: MONO_FONT,
            fontSize: PX_SMALL,
            color: COLOR_FAINT,
          })
          .setOrigin(1, 0)
          .setDepth(DEPTH_PANEL + 2);
        push(chipBg, 0);
        push(chipLabel, 0);
        push(imp, 0);
        push(bodyText, rowH);
        y += rowH;
      }
    }

    this.panelContentH = y - this.panelContentTop;
    this.layoutPanel();
  }

  /**
   * Apply the wheel scroll to the inspector content below the stat strip:
   * translate every content object by the clamped scroll offset and hide the
   * ones whose top falls outside the content window (visibility clip — the rail
   * card has a hard bottom). The header/stat-strip chrome stays fixed.
   */
  private layoutPanel(): void {
    const top = this.panelContentTop;
    const bottom = this.hud.panelY + this.hud.panelH - 8;
    const availH = bottom - top;
    const minScroll = Math.min(0, availH - this.panelContentH);
    this.traceScroll = Phaser.Math.Clamp(this.traceScroll, minScroll, 0);
    for (const c of this.panelContent) {
      const ny = Math.round(c.baseY + this.traceScroll);
      c.obj.setY(ny);
      // Hide content scrolled above the window top or below the card bottom.
      c.obj.setVisible(ny + c.h > top && ny < bottom);
    }
  }

  private onWheel(pointer: Phaser.Input.Pointer, deltaY: number): void {
    // Bottom agent strip: wheel scrolls the card row horizontally. Accumulate
    // delta and advance ONE card per notch of travel so trackpads (which fire a
    // burst of small deltas) step smoothly instead of flying through the cards.
    if (pointer.y >= this.hud.stripY && pointer.x < this.hud.rightX) {
      const WHEEL_NOTCH = 80;
      this.cardScrollAccum += deltaY;
      while (this.cardScrollAccum >= WHEEL_NOTCH) {
        this.cardScrollAccum -= WHEEL_NOTCH;
        this.scrollCards(1);
      }
      while (this.cardScrollAccum <= -WHEEL_NOTCH) {
        this.cardScrollAccum += WHEEL_NOTCH;
        this.scrollCards(-1);
      }
      return;
    }
    if (!this.selectedAgent) return;
    if (!pointInRect(pointer.x, pointer.y, this.hud.panelRect)) return;
    this.traceScroll -= deltaY * 0.25;
    this.layoutPanel();
  }
}
