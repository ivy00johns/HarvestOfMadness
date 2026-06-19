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
import type { DecisionTraceEntry, WorldEvent } from "@contracts/types";
import {
  FeedModel,
  formatFeedItem,
  type FeedItem,
} from "../obs/Feed";
import { KillSwitchModel } from "../obs/KillSwitch";
import { toCssColor } from "../obs/EventLog";
import {
  buildAgentCard,
  formatAffinityRow,
  formatNeedsRow,
  formatTraceEntry,
  formatTraceSummary,
  personaText,
  topRelationships,
  type ObsAgentCardModel,
} from "../obs/Inspector";
import {
  FONT_SIZE_BASE,
  FONT_SIZE_SMALL,
  FONT_SIZE_TITLE,
  HUD_FONT,
  HUD_FONT_BODY,
  MONO_FONT,
  REG_HUD,
  computeHud,
  pointInRect,
  unionRect,
  type HudLayout,
} from "../obs/layout";
import {
  borderCard,
  borderControl,
  brand400,
  brand600,
  card as cardSurface,
  cmdGradTop,
  control,
  cyan300,
  cyan500,
  ink300,
  ink400,
  ink500,
  p1,
  p2,
  positive500,
  white,
} from "../obs/theme";
import { formatCognitionMeter } from "../obs/CognitionMeter";
import { buildPartyPanel } from "../obs/PartyPanel";
import { buildGovernancePanel } from "../obs/GovernancePanel";
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

// SpaceCon palette (cool-navy mission-control): these constants keep their
// names so every existing usage picks up the navy palette, but their VALUES are
// now sourced from the design-token module (src/obs/theme.ts — single source of
// truth). Semantic mapping per contracts/phase-b-foundation.md §Retheme map.
const COLOR_TEXT = white.hex; // body — white
const COLOR_DIM = ink300.hex; // secondary labels — ink300 (body)
const COLOR_FAINT = ink500.hex; // tertiary / faint meta — ink500
const COLOR_GOLD = p2.hex; // gold → amber (P2)
const COLOR_GOAL = cyan300.hex; // the one accent → cyan300
const COLOR_PLAN = brand400.hex; // plan → brand400
const COLOR_OK = positive500.hex; // ok → positive500
const COLOR_BAD = p1.hex; // bad → red (P1)
const COLOR_CHROME = cardSurface.num; // chrome → card surface
const COLOR_CARD_BG = cardSurface.num; // card background → card surface
const COLOR_BORDER = borderCard.num; // separator → card border
const COLOR_HEADER = ink400.hex; // mono section-header labels → ink400

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

const FSM_COLORS: Record<string, string> = {
  IDLE: ink400.hex,
  THINKING: p2.hex,
  EXECUTING: positive500.hex,
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
  needs: Phaser.GameObjects.Text;
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

  // v3 — live party showcase strip (top-left, over the trace-panel band)
  private partyBg: Phaser.GameObjects.Rectangle | null = null;
  private partyTitle: Phaser.GameObjects.Text | null = null;
  private partyMeta: Phaser.GameObjects.Text | null = null;
  private partyKnow: Phaser.GameObjects.Text | null = null;
  private partyInvited: Phaser.GameObjects.Text | null = null;
  private partyArrived: Phaser.GameObjects.Text | null = null;
  /** Whether the party strip is currently shown — gates HUD click-through so
   *  clicks on the visible strip don't pan/follow the world map underneath. */
  private partyVisible = false;
  /** arrivals accumulated from the bus (event_arrived), keyed by eventId.
   *  Scene state — survives relayout(); arrivals live in Cognition, not EventBoard. */
  private readonly arrivedByEvent = new Map<string, Set<string>>();

  // Wave 4c — live governance showcase strip (shares the party band; the party
  // event takes priority when both are present).
  private govBg: Phaser.GameObjects.Rectangle | null = null;
  private govTitle: Phaser.GameObjects.Text | null = null;
  private govMeta: Phaser.GameObjects.Text | null = null;
  private govTally: Phaser.GameObjects.Text | null = null;
  /** Whether the governance strip is currently shown — gates HUD click-through. */
  private govVisible = false;

  // v3 (Wave 2) — conversation transcript panel (left band, below the party strip)
  private transcriptBg: Phaser.GameObjects.Rectangle | null = null;
  private transcriptTitle: Phaser.GameObjects.Text | null = null;
  private transcriptRows: Phaser.GameObjects.Text[] = [];
  /** rows the transcript panel can show (one Text per line). The right-panel
   *  conversation region is tall now, so we show a deeper backlog. */
  private static readonly TRANSCRIPT_MAX_LINES = 14;
  /** latest conversation parsed off the bus, rendered when no panel overlays it */
  private latestConversation: Conversation | null = null;
  /** Whether the transcript panel is currently shown — gates HUD click-through. */
  private transcriptVisible = false;

  // event feed
  private logTexts: Phaser.GameObjects.Text[] = [];
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
    this.hud = computeHud(this.scale.width, this.scale.height);
    this.buildCommandBar();
    this.buildSectionHeaders();
    this.buildFeedChrome();
    this.buildPartyChrome();
    this.buildGovernanceChrome();
    this.buildTranscriptChrome();
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
    this.feedLineItems = [];
    this.panelObjects = [];
    this.panelEntryTexts = [];
    this.panelTraceEntries = [];
    this.selectedAgent = null;
    // removeAll(true) destroyed the party strip objects — drop the stale refs;
    // buildPartyChrome() recreates them. arrivedByEvent is sim state, kept.
    this.partyBg = null;
    this.partyTitle = null;
    this.partyMeta = null;
    this.partyKnow = null;
    this.partyInvited = null;
    this.partyArrived = null;
    // Wave 4c — governance strip objects were destroyed too; drop stale refs.
    this.govBg = null;
    this.govTitle = null;
    this.govMeta = null;
    this.govTally = null;
    this.govVisible = false;
    // removeAll(true) destroyed the transcript chrome too — drop the stale refs;
    // buildTranscriptChrome() recreates them. latestConversation is sim state, kept.
    this.transcriptBg = null;
    this.transcriptTitle = null;
    this.transcriptRows = [];
    this.transcriptVisible = false;
    this.agentsHeader = null;
    // removeAll(true) destroyed the command-bar children — drop stale refs in
    // the segment maps so buildCommandBar() repopulates them cleanly.
    this.speedBtns.clear();
    this.speedBtnBgs.clear();
    this.modeBtns.clear();
    this.modeBtnBgs.clear();
    this.buildCommandBar();
    this.buildSectionHeaders();
    this.buildFeedChrome();
    this.buildPartyChrome();
    this.buildGovernanceChrome();
    this.buildTranscriptChrome();
    this.refreshAll();
    if (reopen) this.toggleTracePanel(reopen);
    this.publishPanelRect();
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
    // CONVERSATION label at the very top of the right panel.
    this.add
      .text(r.x + 10, r.y + 6, "CONVERSATION", headerStyle)
      .setDepth(DEPTH_HUD_TEXT);
    // AGENTS · N label above the bottom strip.
    this.agentsHeader = this.add
      .text(8, this.hud.stripHeaderY, "AGENTS", headerStyle)
      .setDepth(DEPTH_HUD_TEXT);
  }

  /** WorldScene reads this rect to ignore camera clicks over the open panel.
   *  Priority: an open trace panel (covers the whole band) > the visible left-band
   *  chrome (party strip and/or transcript panel, combined via unionRect) >
   *  nothing. Without these cases, clicks on the visible chrome fall through and
   *  pan/follow the world map underneath. */
  private publishPanelRect(): void {
    let rect = null;
    if (this.selectedAgent) {
      rect = this.hud.panelRect;
    } else {
      // The party strip and the governance strip share the same band
      // (hud.partyRect); union it with the transcript rect when visible.
      const bandVisible = this.partyVisible || this.govVisible;
      if (bandVisible && this.transcriptVisible) {
        rect = unionRect(this.hud.partyRect, this.hud.transcriptRect);
      } else if (bandVisible) {
        rect = this.hud.partyRect;
      } else if (this.transcriptVisible) {
        rect = this.hud.transcriptRect;
      }
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
    this.renderFeed();
    this.renderCards();
    this.renderParty();
    this.renderGovernance();
    this.renderTranscript();
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
      ui.fsm.setText(agent.fsm).setColor(FSM_COLORS[agent.fsm] ?? "#8a8f98");
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
        this.onPanelClick(py);
        return; // panel swallows its clicks — nothing leaks to the map
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

  private buildFeedChrome(): void {
    this.add
      .rectangle(this.hud.logX, this.hud.logY, this.hud.logW, this.hud.logH, COLOR_CHROME, 0.9)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD);
    // Section header in the gutter just above the feed rect — gives the eye a
    // clear "EVENTS" region marker without eating any feed-line space.
    this.add
      .text(this.hud.logX + this.hud.logPadX, this.hud.logY - FONT_SIZE_SMALL - 5, "EVENTS", {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        fontStyle: "bold",
        color: COLOR_HEADER,
      })
      .setDepth(DEPTH_HUD_TEXT);
    for (let i = 0; i < this.hud.logLines; i++) {
      this.logTexts.push(
        this.add
          .text(
            this.hud.logX + this.hud.logPadX,
            this.hud.logY + this.hud.logPadY + i * this.hud.logLineH,
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
      if (!line) continue;
      const item = items[i] ?? null;
      this.feedLineItems[i] = item;
      if (item) {
        const view = formatFeedItem(item, this.hud.logMaxChars);
        line.setText(view.text);
        line.setColor(toCssColor(view.color));
        line.setFontStyle(view.emphasis ? "bold" : "normal");
      } else if (line.text !== "") {
        line.setText("");
      }
    }
  }

  // -- live party showcase strip --------------------------------------------------

  /**
   * Build the standing party strip chrome (backing rect + texts) at
   * hud.partyRect. Starts hidden; renderParty() shows it when there is a
   * showcase event. No nested containers (Phaser 4.1 gotcha).
   */
  private buildPartyChrome(): void {
    const r = this.hud.partyRect;
    this.partyBg = this.add
      .rectangle(r.x, r.y, r.w, r.h, COLOR_CHROME, 0.92)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD)
      .setVisible(false);
    const mk = (
      dy: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(r.x + 10, r.y + dy, "", style)
        .setDepth(DEPTH_HUD_TEXT)
        .setVisible(false);

    this.partyTitle = mk(8, {
      fontFamily: HUD_FONT,
      fontSize: PX_BASE,
      fontStyle: "bold",
      color: COLOR_GOAL,
    });
    this.partyMeta = mk(30, {
      fontFamily: HUD_FONT,
      fontSize: PX_SMALL,
      color: COLOR_DIM,
    });
    this.partyKnow = mk(52, {
      fontFamily: HUD_FONT,
      fontSize: PX_SMALL,
      color: COLOR_TEXT,
    });
    this.partyInvited = mk(74, {
      fontFamily: HUD_FONT,
      fontSize: PX_SMALL,
      color: COLOR_PLAN,
    });
    this.partyArrived = this.add
      .text(r.x + r.w - 10, r.y + 74, "", {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        color: COLOR_OK,
      })
      .setOrigin(1, 0)
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
  }

  /**
   * Render the live party showcase. Reads the soonest non-past event via the
   * optional wiring seams; hides the strip when there is no event (mock/absent)
   * or while a trace panel is open (the panel overlays the same band). Event-
   * driven via markDirty()→refreshAll() throttle — not per-frame.
   */
  private renderParty(): void {
    if (this.destroyed || !this.partyBg) return;
    const controls = this.conn?.controls;
    const eventId = controls?.showcaseEventId?.() ?? null;
    const snap = eventId ? controls?.attendanceSnapshot?.(eventId) : undefined;
    // Hide while a card's trace panel is open (it occupies the same band).
    if (!snap || this.selectedAgent) {
      this.setPartyVisible(false);
      return;
    }
    const town = controls?.agents().length ?? 0;
    const arrived = (eventId && this.arrivedByEvent.get(eventId)) || new Set<string>();
    const view = buildPartyPanel(snap, arrived, town);

    this.partyTitle?.setText(this.clip(`★ ${view.description}`, 36));
    this.partyMeta?.setText(
      this.clip(
        `host ${view.host} · day ${snap.event.day} ${snap.event.phase}`,
        38,
      ),
    );
    this.partyKnow?.setText(view.knowLine);
    this.partyInvited?.setText(`invited: ${view.invitedCount}`);
    this.partyArrived?.setText(`arrived: ${view.arrivedCount}`);
    this.setPartyVisible(true);
  }

  private setPartyVisible(visible: boolean): void {
    this.partyVisible = visible;
    this.partyBg?.setVisible(visible);
    this.partyTitle?.setVisible(visible);
    this.partyMeta?.setVisible(visible);
    this.partyKnow?.setVisible(visible);
    this.partyInvited?.setVisible(visible);
    this.partyArrived?.setVisible(visible);
    // Keep the click-through guard in sync with what's actually drawn.
    this.publishPanelRect();
  }

  // -- live governance showcase strip (Wave 4c) ----------------------------------

  /**
   * Build the standing governance strip chrome (backing rect + texts) at
   * hud.partyRect — it shares the party band, shown only when there is no party
   * event to display. Starts hidden; renderGovernance() shows it when there is
   * an open town proposal. No nested containers (Phaser 4.1 gotcha).
   */
  private buildGovernanceChrome(): void {
    const r = this.hud.partyRect;
    this.govBg = this.add
      .rectangle(r.x, r.y, r.w, r.h, COLOR_CHROME, 0.92)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD)
      .setVisible(false);
    const mk = (
      dy: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(r.x + 10, r.y + dy, "", style)
        .setDepth(DEPTH_HUD_TEXT)
        .setVisible(false);
    this.govTitle = mk(8, {
      fontFamily: HUD_FONT,
      fontSize: PX_BASE,
      fontStyle: "bold",
      color: COLOR_PLAN,
    });
    this.govMeta = mk(30, {
      fontFamily: HUD_FONT,
      fontSize: PX_SMALL,
      color: COLOR_DIM,
    });
    this.govTally = mk(52, {
      fontFamily: MONO_FONT,
      fontSize: PX_SMALL,
      color: COLOR_TEXT,
    });
  }

  /**
   * Render the live governance showcase. Reads the current proposal tally via
   * the optional wiring seam. Hidden when there is no proposal, while a trace
   * panel is open, or while the party strip occupies the band (the party event
   * wins). Event-driven via markDirty()→refreshAll() throttle — not per-frame.
   */
  private renderGovernance(): void {
    if (this.destroyed || !this.govBg) return;
    const controls = this.conn?.controls;
    const tally = controls?.governanceTally?.();
    // The party strip owns the band when an event is showing; only show
    // governance when neither the party strip nor a trace panel is up.
    if (!tally || this.selectedAgent || this.partyVisible) {
      this.setGovernanceVisible(false);
      return;
    }
    const town = controls?.agents().length ?? 0;
    const view = buildGovernancePanel(tally, town);
    const verb =
      view.status === "adopted"
        ? "ADOPTED"
        : view.status === "rejected"
          ? "REJECTED"
          : "town rule up for a vote";
    this.govTitle?.setText(this.clip(`⚖ ${view.ruleText}`, 40));
    this.govMeta?.setText(this.clip(`by ${view.proposer} · ${verb}`, 40));
    this.govTally?.setText(view.tallyLine);
    this.setGovernanceVisible(true);
  }

  private setGovernanceVisible(visible: boolean): void {
    this.govVisible = visible;
    this.govBg?.setVisible(visible);
    this.govTitle?.setVisible(visible);
    this.govMeta?.setVisible(visible);
    this.govTally?.setVisible(visible);
    // Keep the click-through guard in sync with what's actually drawn.
    this.publishPanelRect();
  }

  // -- conversation transcript panel ---------------------------------------------

  /**
   * Build the standing transcript panel chrome (backing rect + bold title +
   * fixed row of wrapped Text lines) at hud.transcriptRect. Starts hidden;
   * renderTranscript() fills + shows it when there is a conversation to display
   * and no trace panel overlays the band. No nested containers (Phaser 4.1).
   */
  private buildTranscriptChrome(): void {
    const r = this.hud.transcriptRect;
    this.transcriptBg = this.add
      .rectangle(r.x, r.y, r.w, r.h, COLOR_CHROME, 0.92)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD)
      .setVisible(false);
    // The persistent "CONVERSATION" header (buildSectionHeaders) labels this
    // region; a slim "now speaking" caption sits at the top of the panel body.
    this.transcriptTitle = this.add
      .text(r.x + 10, r.y + 6, "", {
        fontFamily: HUD_FONT_BODY,
        fontSize: PX_SMALL,
        color: COLOR_FAINT,
      })
      .setDepth(DEPTH_HUD_TEXT)
      .setVisible(false);
    this.transcriptRows = [];
    const rowTop = r.y + 28;
    // WORD-WRAPPED rows: each utterance wraps to the panel width and the render
    // pass reflows them by measured height, so full sentences are readable
    // instead of clipped to "Good to se…" (Smallville keeps the full text in the
    // side panel). renderTranscript repositions each row's Y on every refresh.
    for (let i = 0; i < UIScene.TRANSCRIPT_MAX_LINES; i++) {
      this.transcriptRows.push(
        this.add
          .text(r.x + 10, rowTop, "", {
            fontFamily: HUD_FONT_BODY,
            fontSize: PX_SMALL,
            color: COLOR_TEXT,
            wordWrap: { width: r.w - 20 },
            lineSpacing: 2,
          })
          .setDepth(DEPTH_HUD_TEXT)
          .setVisible(false),
      );
    }
  }

  /**
   * Render the latest conversation into the transcript panel. Hides the panel
   * when there is no conversation (empty) OR while a trace panel is open (it
   * overlays the same left band). Each line shows "[speaker]: text" with the two
   * participants' lines in alternating colors. Event-driven via the markDirty()
   * → refreshAll() throttle — not per-frame.
   */
  private renderTranscript(): void {
    if (this.destroyed || !this.transcriptBg) return;
    const view = buildTranscript(
      this.latestConversation,
      UIScene.TRANSCRIPT_MAX_LINES,
      240, // keep near-full utterances; the row Text word-wraps to the panel
    );
    if (view.empty || this.selectedAgent) {
      this.setTranscriptVisible(false);
      return;
    }
    const [p0, p1] = view.participants;
    this.transcriptTitle?.setText(
      this.clip(`${p0 ?? ""}${p1 ? ` ↔ ${p1}` : ""}`, 40),
    );
    // Reflow word-wrapped rows top→down by their measured height; the two
    // speakers alternate color. Rows that would spill past the panel bottom are
    // hidden (conversations are short, so the recent turns fit).
    const r = this.hud.transcriptRect;
    let y = r.y + 28;
    const bottom = r.y + r.h - 4;
    for (let i = 0; i < this.transcriptRows.length; i++) {
      const row = this.transcriptRows[i];
      const line = view.lines[i];
      if (line && y < bottom) {
        // Full utterance (capped against a pathological single huge turn); the
        // Text object word-wraps it to the panel width.
        row.setText(`[${line.speaker}]: ${this.clip(line.text, 240)}`);
        row.setColor(line.speaker === p0 ? COLOR_GOAL : COLOR_PLAN);
        row.setY(Math.round(y));
        row.setVisible(true);
        y += row.height + 4;
      } else {
        if (row.text !== "") row.setText("");
        row.setVisible(false);
      }
    }
    this.setTranscriptVisible(true);
  }

  private setTranscriptVisible(visible: boolean): void {
    this.transcriptVisible = visible;
    this.transcriptBg?.setVisible(visible);
    this.transcriptTitle?.setVisible(visible);
    if (!visible) {
      for (const row of this.transcriptRows) row.setVisible(false);
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
    const padX = 9;
    const small = { fontFamily: HUD_FONT, fontSize: PX_SMALL, color: COLOR_DIM };
    const smallMono = { fontFamily: MONO_FONT, fontSize: PX_SMALL, color: COLOR_DIM };
    const text = (
      tx: number,
      ty: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
    ): Phaser.GameObjects.Text =>
      this.add.text(tx, ty, "", style).setDepth(DEPTH_HUD_TEXT);

    const bg = this.add
      .rectangle(x, y, cardW, cardH, COLOR_CARD_BG, 0.97)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLOR_BORDER, 1)
      .setDepth(DEPTH_HUD);

    // visual sprite link: swatch in the agent's sprite color
    const swatch = this.add
      .rectangle(x + padX, y + 8, 12, 12, 0xffffff, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, 0xffffff, 0.5)
      .setDepth(DEPTH_HUD_TEXT);

    // Fixed vertical stack — 8 single-line body rows spaced by a comfortable
    // pitch that fits the ~174px card body without collision.
    const headerH = 22;
    const pitch = Math.min(19, Math.max(15, Math.floor((cardH - headerH - 4) / 8)));
    const rowY = (slot: number): number => y + headerH + slot * pitch;

    const rowGold = rowY(0);
    const rowPlan = rowY(1);
    const rowGoal = rowY(2);
    const rowNeeds = rowY(3); // intrinsic-drive bars on their OWN full-width row
    const rowThought = rowY(4);
    const rowAction = rowY(5);
    const rowRel = rowY(6);
    const rowMeta = rowY(7);

    const barW = Math.round(cardW * 0.32);
    const barX = x + cardW - barW - 34;

    return {
      bg,
      swatch,
      name: text(x + padX + 18, y + 5, {
        fontFamily: HUD_FONT,
        fontSize: PX_BASE,
        color: "#ffffff",
        fontStyle: "bold",
      }),
      fsm: text(x + cardW - padX, y + 7, { ...small }).setOrigin(1, 0),
      gold: text(x + padX, rowGold, {
        fontFamily: MONO_FONT,
        fontSize: PX_SMALL,
        color: COLOR_GOLD,
      }),
      energyBg: this.add
        .rectangle(barX, rowGold + 3, barW, 9, 0x323844, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyFill: this.add
        .rectangle(barX, rowGold + 3, barW, 9, positive500.num, 1)
        .setOrigin(0, 0)
        .setDepth(DEPTH_HUD_TEXT),
      energyText: text(x + cardW - padX, rowGold, { ...smallMono }).setOrigin(1, 0),
      plan: text(x + padX, rowPlan, { ...small, color: COLOR_PLAN }),
      // Prose row: the goal reads as body copy → IBM Plex Sans (FONT_BODY).
      goal: text(x + padX, rowGoal, {
        ...small,
        fontFamily: HUD_FONT_BODY,
        color: COLOR_GOAL,
      }),
      // Wave 3a — intrinsic-drive bars on their own left-aligned row (full width).
      needs: text(x + padX, rowNeeds, { ...smallMono }),
      // Prose row: the thought quote reads as body copy → IBM Plex Sans.
      thought: text(x + padX, rowThought, {
        ...small,
        fontFamily: HUD_FONT_BODY,
        color: ink300.hex,
      }),
      action: text(x + padX, rowAction, {
        fontFamily: HUD_FONT,
        fontSize: PX_SMALL,
        color: COLOR_OK,
      }),
      relRows: [text(x + padX, rowRel, { ...small })],
      meta: text(x + padX, rowMeta, { ...smallMono, color: COLOR_FAINT }),
    };
  }

  private updateCard(ui: CardUi, card: ObsAgentCardModel): void {
    if (typeof card.color === "number") ui.swatch.setFillStyle(card.color, 1);
    // Wave 4a — append the derived role to the name only when non-default.
    const roleTag = card.role && card.role !== "farmer" ? ` · ${card.role}` : "";
    // Clip the name short so the right-aligned FSM chip never collides with it.
    ui.name.setText(this.clip(`${card.name}${roleTag}`, 19));
    ui.fsm.setText(card.fsm).setColor(FSM_COLORS[card.fsm] ?? "#8a8f98");
    ui.gold.setText(`${card.gold}g`);
    this.updateEnergy(ui, card.energy);

    // v2: current plan step ("PLAN: water east plot") — hidden when absent.
    // Clip lengths tuned to the ~246px strip card (≈30 chars usable).
    ui.plan.setText(card.planStep ? this.clip(`PLAN: ${card.planStep}`, 30) : "");
    ui.goal.setText(this.clip(`goal: ${card.goal ?? "—"}`, 30));
    // Wave 3a — intrinsic-drive bars on their own row (empty when no needs vector)
    ui.needs.setText(card.needs ? formatNeedsRow(card.needs) : "");
    // single thought line in the compact card (full thought in the trace panel)
    ui.thought?.setText(card.lastThought ? `“${this.clip(card.lastThought, 28)}”` : "…");

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
        32,
      ),
    );
  }

  private updateEnergy(ui: CardUi, energy: number): void {
    const ratio = Phaser.Math.Clamp(energy, 0, 100) / 100;
    const fullW = ui.energyBg.width;
    ui.energyFill.setSize(Math.max(1, Math.round(fullW * ratio)), 9);
    // Energy color rule: >50% positive, >25% amber, else red. (Pre-existing
    // thresholds kept; design §4 specifies >55% — aligned in the B-5 card slice.)
    ui.energyFill.setFillStyle(
      ratio > 0.5 ? positive500.num : ratio > 0.25 ? p2.num : p1.num,
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
    // Auto-expand the newest entry (obs backlog: panel opened fully collapsed).
    const first = this.panelTraceEntries[0];
    if (first) {
      this.expandedTurnIds.add(first.turnId);
      this.rebuildPanelEntries();
    }
    this.renderParty(); // hide the party strip behind the open panel
    this.renderTranscript(); // hide the transcript panel behind the open panel
    this.publishPanelRect();
  }

  private buildPanelChrome(name: string): void {
    // v1 defect d: text sat directly on the map — the panel now has a
    // near-opaque backing rect plus a visible border.
    const bg = this.add
      .rectangle(this.hud.panelX, this.hud.panelY, this.hud.panelW, this.hud.panelH, 0x191d24, 0.97)
      .setOrigin(0, 0)
      .setStrokeStyle(2, COLOR_BORDER, 1)
      .setDepth(DEPTH_PANEL);
    const title = this.add
      .text(this.hud.panelX + 10, this.hud.panelY + 6, `${name} — decision trace`, {
        fontFamily: HUD_FONT,
        fontSize: PX_TITLE,
        fontStyle: "bold",
        color: COLOR_TEXT,
      })
      .setDepth(DEPTH_PANEL + 1);
    const agent = (this.conn?.controls.agents() ?? []).find((a) => a.name === name);
    const subtitle = this.add
      .text(
        this.hud.panelX + 10,
        this.hud.panelY + 26,
        this.clip(
          `${agent ? personaText(agent.persona) : ""} · click a row to expand · wheel scrolls`,
          70,
        ),
        // Persona prose → IBM Plex Sans (FONT_BODY).
        { fontFamily: HUD_FONT_BODY, fontSize: PX_SMALL, color: COLOR_FAINT },
      )
      .setDepth(DEPTH_PANEL + 1);
    const close = this.add
      .text(this.hud.panelX + this.hud.panelW - 10, this.hud.panelY + 6, "✕", {
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
    this.renderParty(); // restore the party strip once the panel closes
    this.renderTranscript(); // restore the transcript panel once the panel closes
    this.publishPanelRect();
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

    const entries = buildAgentCard(agent).trace.slice(0, this.hud.panelVisibleTrace);
    this.panelTraceEntries = entries;
    for (const entry of entries) {
      const expanded = this.expandedTurnIds.has(entry.turnId);
      const content = expanded
        ? `▾ ${formatTraceSummary(entry, 68)}\n${this.indent(formatTraceEntry(entry))}`
        : `▸ ${formatTraceSummary(entry, 68)}`;
      const textObj = this.add
        .text(this.hud.panelX + 10, 0, content, {
          fontFamily: MONO_FONT,
          fontSize: PX_SMALL,
          color: expanded ? "#cdd3dd" : COLOR_DIM,
          // advanced wrap: raw JSON has no spaces, must hard-break long runs
          wordWrap: { width: this.hud.panelW - 20, useAdvancedWrap: true },
        })
        .setDepth(DEPTH_PANEL + 1);
      this.panelEntryTexts.push(textObj);
    }
    if (entries.length === 0) {
      const empty = this.add
        .text(this.hud.panelX + 10, 0, "(no decisions yet)", {
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
    const top = this.hud.panelY + this.hud.panelHeaderH;
    const availH = this.hud.panelH - this.hud.panelHeaderH - 6;
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
