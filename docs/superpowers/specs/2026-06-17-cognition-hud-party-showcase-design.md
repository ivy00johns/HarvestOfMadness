# Cognition-Cost HUD + Live Party Showcase — Implementation Spec

> Wave-1 workstream **B**. Two LOW-risk ADDITIVE observability features. NO contract churn. Suite is 768 green; the bar is **768+ green + `tsc` clean**, no files touched outside the ownership list.

## Wiring topology (load-bearing)
The HUD reaches the sim through one seam: `connectObservability()` in `src/obs/wiring.ts` returns `{ bus: getEventBus(), controls: getAgentManager() }`. `SimControls` (wiring.ts) is the narrow surface (`pause/resume/step/setSpeed/isPaused/agents`). `AgentManager` already exposes `cognition(): CognitionSystem | null` but it is NOT on `SimControls`, so UIScene can't see it yet. This is the single integration point both features extend — **in `wiring.ts`, which we own** (we do NOT edit `AgentManager.ts`).

## Feature 1 — Cognition-cost HUD (S/low)
- Metrics already exist in `src/agents/Cognition.ts`: `CognitionMetrics` interface (fields `planCalls`, `reflectionCalls`, `relationshipCalls`, `importanceCalls`) + public `readonly metrics`. Increments fire only on live LLM calls via `onLiveCall` callbacks (reflection/plan/relationship/importance). Mock mode never increments. Consumed by nothing today.
- **Add ONE read-only getter** (do not change increments):
  ```ts
  /** Read-only snapshot of cognition LLM spend. Never mutates. */
  metricsSnapshot(): Readonly<CognitionMetrics> { return { ...this.metrics }; }
  ```
- **Surface:** compact right-aligned tally in the **badge row** (next to the kill-switch/LIVE badge), distinct from decision-layer spend (which lives on agent cards as model/latency/tokens). Format `cog P{plan} R{reflect} I{importance} L{relationship} · {total}`.

## Feature 2 — Live party showcase (M/low)
- Party emergence is already live + recurring (`AgentManager` reseeds a tavern gathering each `day_advanced` + a one-time day-2 party). `EventBoard` is the diffusion source of truth (`seed/all/get/markKnows/knows/knownBy/knowerCount`; internal `events:Map`, `knowledge:Map<id,Set<name>>`). It has knows but no invited/arrived.
- **Add ONE read-only getter + interface to `src/agents/EventBoard.ts`:**
  ```ts
  export interface EventAttendanceSnapshot {
    event: SimEvent; knowers: string[]; invited: string[]; knowerCount: number;
  }
  attendanceSnapshot(eventId: string): EventAttendanceSnapshot | undefined {
    const event = this.events.get(eventId); if (!event) return undefined;
    const knowers = [...(this.knowledge.get(eventId) ?? new Set<string>())];
    return { event, knowers, invited: knowers.filter(n => n !== event.host), knowerCount: knowers.length };
  }
  ```
- **Arrived** is NOT in EventBoard (it's a private `arrivedAtEvent` Set in Cognition keyed `name|eventId`). Source arrivals from the **bus** instead: `event_arrived` `{ payload:{ eventId, agentName } }` is already emitted (open-union kind, no contract change). UIScene already subscribes to the bus; accumulate arrivals per event there.
- **Surface:** a new dedicated **PartyPanel** (standing snapshot that updates in place — "9/12 know"), NOT Feed enrichment (Feed scrolls away). Docked top-left in the trace-panel band (slim strip, ≤96px). Shows description, host, location, `{knowers}/{town} know`, `invited: N`, `arrived: N`.

## obs surfaces — new pure files
- `src/obs/CognitionMeter.ts` — `formatCognitionMeter(m: CognitionMetrics|null|undefined): {text, total}`; null → `"cog P0 R0 I0 L0 · 0"` (mock/disabled graceful, never throws). Type-only import of `CognitionMetrics`.
- `src/obs/PartyPanel.ts` — `buildPartyPanel(snap: EventAttendanceSnapshot, arrivedNames: ReadonlySet<string>, townSize: number, maxNames=6): PartyPanelView`. `arrivedCount` = |knowers ∩ arrivedNames|. `knowLine = "{knowerCount}/{townSize} know"`.

## wiring.ts (extend — in-bounds)
Add optional read-only members to `SimControls` (optional `?` → existing stubs still typecheck):
```ts
cognitionMetrics?(): Readonly<CognitionMetrics> | null;
attendanceSnapshot?(eventId: string): EventAttendanceSnapshot | undefined;
showcaseEventId?(): string | null;   // soonest non-past event id, or null
```
Implement in `connectObservability()` via `Object.assign(getAgentManager(), {...})` reading the existing `cognition()` getter + the two new getters. `showcaseEventId` = from `cog.events.all()` pick the soonest non-past event (lowest day, then phase order via a local `{morning:0,afternoon:1,evening:2,night:3}` map); guard `cog===null`.

## layout.ts (additive only)
Add NEW `party{X,Y,W,H,Rect}` fields to `HudLayout` + `computeHud` — reuse `panelX/panelY/panelW`, `partyH = min(96, max(60, panelH))`, all `Math.round`/`Math.min` of integer inputs (integer-pixel invariant holds). **Change NO existing `DESIGN.*`/`PANEL_*`/`LOG_*`/`CARD_*` value** (or `tests/obs/layout.test.ts` breaks). The party strip overlays the trace-panel band (trace panel is transient, opened on card click; optionally hide party strip while a card is selected). Fonts ≥12px (rule 14).

## UIScene.ts
- Badge row: add right-aligned `cogMeter` Text (origin (1,0)); `renderCogMeter()` reads `controls.cognitionMetrics?.()` → `formatCognitionMeter`; call from `refreshAll()` + `refreshLive()`.
- Party chrome: `buildPartyChrome()` (called from `create()` + `relayout()`) builds backing rect + title/meta/know/invited/arrived Texts at `hud.partyRect`. `renderParty()` reads `showcaseEventId?()`→`attendanceSnapshot?()`; hide when null/undefined; `town = controls.agents().length`; `buildPartyPanel(snap, arrivedByEvent.get(id) ?? new Set(), town)`. Event-driven via existing `markDirty()`→`refreshAll()` throttle (NOT per-frame).
- Arrival tracking: `private arrivedByEvent = new Map<string, Set<string>>()`. In `onBusEvent()`, before `markDirty()`, accumulate `event_arrived` `{eventId, agentName}`. Also seed from `conn.bus.recent()` in `connect()` (extend the existing kill-switch `recent()` loop) so pre-attach arrivals count. `arrivedByEvent` is scene state, survives `relayout()` (don't reset it).

## Tests (all pure-model/getter; no Phaser scene)
- `tests/agents/cognition-metrics.test.ts` — `metricsSnapshot()` zeroed on fresh mock CognitionSystem; returns a copy (mutation-safe).
- `tests/agents/eventboard-snapshot.test.ts` — unknown id → undefined; seeded host-only → knowerCount 1, invited []; after markKnows 2 → knowerCount 3, invited excludes host; non-mutating.
- `tests/obs/cognitionMeter.test.ts` — null → zeroed text/total 0; populated → total + `P# R# I# L#`.
- `tests/obs/partyPanel.test.ts` — seeded EventBoard, markKnows 8/12 → `knowLine "9/12 know"`, invitedCount 8, arrivedCount = |knowers ∩ arrived|, name cap.
- Confirmed safe (no edit): `tests/obs/layout.test.ts` (only legacy DESIGN consts), party-emergence / recurring-events / event-diffusion (public API + non-mutating getters), inspector/feed/eventlog. No `wiring.test.ts` exists; optional `SimControls` members break no stub.

## File ownership (workstream B owns ONLY)
`src/agents/Cognition.ts` (+1 getter), `src/agents/EventBoard.ts` (+1 getter +interface), `src/obs/CognitionMeter.ts` (new), `src/obs/PartyPanel.ts` (new), `src/obs/wiring.ts`, `src/obs/layout.ts`, `src/scenes/UIScene.ts`, + the 4 NEW test files above. Does NOT touch `contracts/types.ts`, `src/world/**`, `src/scenes/WorldScene.ts`, `src/scenes/BootScene.ts`, `src/agents/AgentManager.ts`, or any other `src/agents/*`. No `SimEvent`/`EventKind` change.

## Risk register
1. Data-reach seam wants AgentManager (out of bounds) → implement readers in `wiring.ts` via `Object.assign`, reading existing `cognition()` getter. AgentManager source untouched.
2. Layout regression → only NEW `party*` fields, zero existing constant changes; trace panel overlay, not displacement.
3. Mock/absent nulls → every render path early-returns/hides; pure formatters accept null; optional `?.()` tolerates stubs.
