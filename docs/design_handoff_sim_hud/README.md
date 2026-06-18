# Handoff: Harvest of Madness — Sim Observability HUD

## Overview
This package redesigns the in-app HUD for the generative-agents farming sim (Madow Valley / Harvest of Madness). It replaces the cramped "Gameboy" debug readout with a **mission-control observability dashboard**: a command bar, a KPI band, a designed map viewport, click-into-agent inspection (decision trace + memory), a Mock↔Live model toggle with cost telemetry, a conversation panel, and an event log.

It pairs with the **map/world plan** (`2026-06-18-option-c-civic-hub-hamlets.md`, included) — that document is the implementation spec for the 140×100 town layout. This README covers the **HUD UI**.

## About the Design Files
The `.dc.html` files in this bundle are **design references** — interactive HTML prototypes that show intended look and behavior. They are **not** production code to copy directly. They were authored in a component runtime ("DC") that is specific to the design tool; do not try to port that runtime.

Your task is to **recreate these designs in the HOM-world-dressing codebase using its existing environment and patterns** — i.e. the project's Phaser 4 scene/DOM-overlay stack (per the research docs) or whatever UI layer the repo already uses for HUD chrome. If the HUD is currently drawn one way, follow that. The canvas map rendering in the prototype is a *stand-in* for the real Phaser map view — you already have the actual game canvas; the prototype only fakes it to show framing, overlays, and the follow-selected behavior.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interaction states are final and come from the bound **SpaceCon Feedback Design System** (cool-navy mission-control palette). Recreate the chrome pixel-accurately using that token set. Exact values are in **Design Tokens** below. The one thing NOT final: the map canvas art (trees/buildings) is placeholder framing — your real Phaser scene replaces it.

---

## Screens / Views

The HUD is a single full-viewport screen with two interchangeable right-rail states.

### 1. Command bar (top, full width)
- **Purpose:** global controls + at-a-glance run telemetry.
- **Layout:** horizontal flex, `padding: 11px 18px`, `gap: 12px`, bottom border `1px solid #1c2740`, background `linear-gradient(180deg,#10192b,#0d1424)`. Left group → flexible spacer → right group.
- **Components (left → right):**
  - **Wordmark:** dot (9px, `--cyan-500`, glow `box-shadow:0 0 9px`) + "MADOW VALLEY" in Space Grotesk 700, 15px, white.
  - **Transport segment:** rounded container (`bg #0c1424`, `border #24324d`, radius 10, padding 3). Play/Pause toggle button (32×28, radius 7) — active state fills `--brand-600` white; idle is transparent `--ink-300`. Plus a step (⏭) button.
  - **Speed segment:** same container; four buttons ½ / 1× / 2× / 4×. Selected fills `--brand-600` white bold; rest transparent `--ink-300`. Mono 12px.
  - **Mock / Live segment:** same container; two buttons. Selected fills `--brand-600` white bold uppercase mono 11px.
  - **Spacer** (`flex:1`).
  - **Clock:** "Day 2 ☀ morning" — mono uppercase label `--ink-400` + Space Grotesk 600 white + sun glyph `--p2-500`.
  - **Telemetry chips** (mono 11px, `border #24324d`, radius 6, padding `3px 8px`): in-flight (`⟳` cyan), latency, tokens, cost. Cost is `--positive-500` at `$0.00` (mock) and `--p2-500` when live/non-zero.

### 2. KPI band (left column, top)
- **Purpose:** the five run-level numbers.
- **Layout:** flex row, `gap: 12px`. Five equal tiles.
- **Tile:** `bg #111c30`, `border 1px #1f2c46`, radius 12, padding `12px 15px`. Mono uppercase label (10.5px, `--ink-400`) over a Space Grotesk 700 24px value.
- **Tiles:** Agents live `12` (white) · Conversations `3` (`--cyan-300`) · Avg energy `71%` (`--positive-500`) · Economy `2,400g` (white, `g` faint) · Decisions `284` (white).

### 3. Map viewport (left column, fills remaining height)
- **Purpose:** the live town view; follows a selected agent.
- **Layout:** `position:relative`, `bg #0d1626`, `border 1px #1f2c46`, radius 14, `overflow:hidden`, `flex:1`, `min-height:360px`, inset hairline shadow. Full-bleed canvas inside (**replace with the real Phaser canvas**).
- **Overlays (absolute):**
  - Top-left context chip: mono uppercase, `rgba(11,18,32,.62)` + `backdrop-filter: blur(6px)`, `border #24324d`, radius 7, padding `5px 10px`. Text e.g. "Organic core · 140×100 · downtown".
  - Top-right **follow chip** (only when an agent is selected): "◎ Following · {name}", white text, `rgba(30,80,200,.5)` + blur, `border --brand-400`, radius 7, `white-space:nowrap`.
  - **Speech bubbles** over agents: white rounded-9 bubble with tail, mono 10px brand-blue (`#1E50C8`) name + Plex Sans 12px near-black (`#0B1220`) text. When an agent is selected, the bubble shows that agent's current thought; otherwise two ambient bubbles show.
  - **Selected agent** gets a 2-ring pulse on the map: inner `#5187F2` stroke + outer `rgba(81,135,242,.35)` halo.

### 4. Agent cards (left column, bottom — horizontal scroller)
- **Purpose:** scan all agents; click to inspect.
- **Layout:** mono uppercase header ("Agents · 12 · click to inspect →"), then a horizontal `overflow-x:auto` flex row, `gap: 12px`.
- **Card:** fixed `width: 248px`, radius 12, padding `13px 14px`, `cursor:pointer`. Idle: `bg #111c30`, `border 1px #1f2c46`. **Selected:** `bg #15233c`, `border 1px --brand-500` + `box-shadow:0 0 0 1px --brand-500`. `transition: border-color .14s`.
- **Card contents (top → bottom):**
  - Header row: color swatch (11px square, agent color, radius 3) + name (Space Grotesk 600 14.5px white, ellipsis) + **state badge**.
  - Stats row: gold (mono 12px `--p2-500`) + energy bar (6px track `#1c2840`, fill colored by level, radius 4) + `E{n}` (mono 10.5px `--ink-400`).
  - Goal: Plex Sans 12px `--ink-300`, `min-height:32px`.
  - Action row: mono 11px (color by verb — see below) + green ✓.
  - Thought quote: Plex Sans 12px italic `--ink-400`, top border `1px #1c2840`, `padding-top:8px`, wrapped in curly quotes.
- **State badge:** mono 9.5px uppercase 600, radius 5, padding `3px 6px`. Executing → `--positive-500` on `rgba(19,126,92,.16)`; Thinking → `--p2-500` on `rgba(185,118,15,.16)`; Idle → `--ink-400` on `rgba(81,96,124,.16)`.
- **Action color:** `TALK_*` → `--cyan-300`; `WAIT` → `--ink-400`; everything else → `--brand-400`.
- **Energy color:** >55 `--positive-500`; >25 `--p2-500`; else `--p1-500`.

### 5. Right rail — DEFAULT state (no agent selected)
Two stacked cards (`bg #111c30`, `border 1px #1f2c46`, radius 14, padding `16px 17px`). Rail width **372px**, fixed.
- **Active conversation card:** mono header; ★ (`--brand-400`) + title "A gathering at the tavern"; "host {name} · day 2 evening" sub; three mini-stat tiles (Know 5/10, Invited 4 `--brand-400`, Arrived 0); then a labeled chat thread — host messages left-aligned bubbles `#16243c` (radius `10 10 10 3`), the other speaker right-aligned `#1d2336` (radius `10 10 3 10`), max-width 88%.
- **Event log card:** mono header; rows of `time (mono 10.5px --ink-500, width 42px)` + colored dot + `who (white 500) + what (--ink-200)`, row hover `#16243c`, radius 7. Dot color encodes event type (plan→positive/brand, decision→`--status-decision`, hosting→cyan, etc.).

### 6. Right rail — INSPECTOR state (an agent is selected)
Replaces the default rail. One tall card, same surface, `border #2f4a6b`.
- **Header:** color swatch (13px) + name (Space Grotesk 700 18px) + persona sub (12px `--ink-400`) + state badge + **close ✕** button (26×26, `border #24324d`, `bg #0c1424`, radius 7).
- **Stat strip:** three mini tiles (`bg #0d1626`, `border #1f2c46`, radius 9) — Gold (`--p2-500`), Energy (level-colored), Decisions (white).
- **Decision trace** (vertical timeline, colored nodes + connector `#1f2c46`):
  1. **Observation** — node `--ink-500`, mono label, `--ink-300` text. What the agent saw (position, nearby targets, inventory, energy).
  2. **Thought** — node `--cyan-500`, label `--cyan-300`, italic `--ink-200`.
  3. **Action** — node `--brand-500`, label `--brand-400`, mono white (e.g. `MOVE_TO (66,49) — shop`).
  4. **Result** — node `--positive-500`, label `--positive-500`, `--ink-300`.
- **Model/cost strip:** `bg #0d1626` pill row — model name (mono 10.5px; `--cyan-300` when live, `--ink-400` when mock) · latency · tokens. Mock shows `mock · 0 ms · 0 tok`; Live shows `fable-5 · {latency} · {tokens}`.
- **Memory stream:** mono header, then rows of a **tag chip** + memory text (`--ink-300`) + importance number (mono 10px `--ink-500`). Tags: `OBS` (`--ink-300` on `#1f2c46`), `REFLECT` (`--cyan-300` on `rgba(42,169,214,.16)`), `PLAN` (`--brand-400` on `rgba(30,80,200,.16)`). Chip: mono 8.5px 600, radius 4, padding `3px 5px`, `min-width:48px`, centered.

---

## Interactions & Behavior
- **Select agent:** click any agent card → right rail swaps DEFAULT → INSPECTOR for that agent; map adds the pulse ring + follow chip; the agent's thought becomes its map speech bubble. Clicking the same card again, or the ✕, deselects (rail returns to DEFAULT).
- **Mock ↔ Live toggle:** flips a single `mode` flag. In **mock**: all telemetry reads zero/cached (`0 ms`, `0 tok`, `$0.00`, model "mock"), thinking agents show "Canned reply (mock)". In **live**: command-bar chips show in-flight count, p50 latency, total tokens, dollar cost; inspector model strip shows `fable-5` + per-call latency/tokens; the "Result" line shows the real in-flight/accepted state. This contrast is the point — it makes the LLM dependency (and its cost/kill-switch) visible.
- **Transport:** Play/Pause toggles an icon + active fill; speed segment selects ½/1×/2×/4×. (Prototype toggles visual state only — wire to the real sim clock.)
- **Hover:** event-log rows tint `#16243c`; segment buttons tint `#1a2742`; cards lift via border/shadow on select.
- **Transitions:** card selection `border-color .14s`. Keep motion calm per the design system (140ms hover, no bounce).

## State Management
Minimal, all local to the HUD:
- `paused: boolean` — transport.
- `speed: 0.5 | 1 | 2 | 4` — sim speed multiplier.
- `mode: 'mock' | 'live'` — model source; drives ALL telemetry display.
- `selected: agentIndex | null` — drives the rail swap, map pulse/follow, and bubble.

Everything else is **derived** from the agent/event data feed. In production, replace the prototype's hardcoded `_agents()` / `events` arrays with the sim's live agent state, the active-conversation record, and the event stream. The agent record shape the UI expects per agent: `{ color, name, persona, state: 'exec'|'think'|'idle', gold, energy, decisions, mapPos:{x,y}, goal, action, actionFull, thought, observation, result, modelLatency, modelTokens, memory: [{type:'obs'|'reflect'|'plan', text, importance}] }`.

## Design Tokens
From the **SpaceCon Feedback Design System** (`tokens/colors.css`). Load the bundle's stylesheets and reference via `var(--*)` rather than hardcoding where possible. Exact values used:

**Surfaces / neutrals**
- App/canvas bg: `#0B1220` (`--ink-900`)
- Map viewport bg: `#0d1626`; command-bar gradient `#10192b → #0d1424`
- Card surface: `#111c30`; selected card `#15233c`; inset tiles `#0d1626`; control containers `#0c1424`
- Borders: card `#1f2c46`; control `#24324d`; inspector `#2f4a6b`; divider/track `#1c2840` / `#1f2c46`
- Text: white `#FFFFFF`; `--ink-300 #A7B0C0` (body), `--ink-400 #76839B` (labels), `--ink-500 #51607C` (faint)

**Brand / accents**
- Brand: `--brand-600 #1E50C8` (active fills), `--brand-500 #2A63E0` (selected border), `--brand-400 #5187F2`
- Cyan: `--cyan-500 #2AA9D6`, `--cyan-300 #7FD3EC`
- Positive: `--positive-500 #18996F`
- Amber (P2): `--p2-500 #D9892B`
- Red (P1): `--p1-500 #D64550`
- Violet (decision): `--status-decision #6A4BC2`

**Semantic tints (badges)**
- exec `rgba(19,126,92,.16)` · think `rgba(185,118,15,.16)` · idle `rgba(81,96,124,.16)`
- REFLECT `rgba(42,169,214,.16)` · PLAN `rgba(30,80,200,.16)` · OBS on `#1f2c46`

**Type** (Google Fonts, loaded by the DS)
- Display: **Space Grotesk** — wordmark, KPI numbers, names, titles. 700/600. Tracking −0.02em at large sizes.
- Body/UI: **IBM Plex Sans** — goals, chat, persona, memory text. 15px base, lh 1.5, `text-wrap:pretty`. HUD uses 12–14.5px.
- Mono: **IBM Plex Mono** — all labels/telemetry/IDs/badges. Uppercase, ~0.05–0.07em tracking. 8.5–12px.

**Radius:** controls/segments 7–10; cards 12–14; badges 4–6; bars 4.
**Shadow:** quiet, navy-tinted. Selected card `0 0 0 1px --brand-500`; map viewport inset `inset 0 0 0 1px rgba(0,0,0,.3)`.

## Assets
- No raster assets. Icons in the prototype are unicode glyphs as placeholders (▶ ⏸ ⏭ ⟳ ☀ ★ ◎ ✓ ✕). **In production, use Lucide** (the design system's icon system; `lucide-react` in a React layer) — e.g. `play`, `pause`, `skip-forward`, `loader`, `sun`, `sparkles`, `crosshair`, `check`, `x`. Sized 13–18px, semantic color, `aria-hidden`.
- Fonts come from the design system's `tokens/fonts.css` (Google Fonts).

## Files
Included in this bundle:
- `Sim HUD Redesign.dc.html` — **the HUD design** (this README documents it). Open in a browser to interact: click cards, toggle Mock/Live.
- `Option C Blueprint.dc.html` — the chosen 140×100 town layout, drawn tile-exact (visual reference for the map work).
- `Town Layout Exploration.dc.html` — the four-option layout study (context for why Option C was chosen).
- `2026-06-18-option-c-civic-hub-hamlets.md` — **the world/map implementation plan** (task-by-task, coordinate tables, gates). This is the spec for the map side; implement it against `src/world/map.ts` etc. as written.

## Notes for implementation
- Recreate the **chrome** (bars, cards, rail, inspector) in the repo's UI layer; keep the **real Phaser canvas** as the map — the prototype's canvas is only framing + the overlay/follow behavior to mirror.
- The Mock/Live split should read from the sim's actual model-runner state and cost accounting, not be a visual toggle.
- Keep the design-system tokens as the single source of color/type — don't reintroduce the old high-contrast debug palette.
