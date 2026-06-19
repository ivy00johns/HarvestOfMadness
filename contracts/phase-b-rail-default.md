# Contract — Phase B-6: SpaceCon right rail (DEFAULT state)

Single source of truth for the implement agent AND verify critics. Restructures the
right rail's DEFAULT state (no agent selected) into the SpaceCon design (README §5):
an **Active-conversation card** + an **Event log card**. Builds on B-0 tokens. The
INSPECTOR state (agent selected → trace panel) is UNCHANGED here — B-7 replaces it.

Run tools nvm-absolute: tests `node_modules/vitest/vitest.mjs run <f>` · full `node_modules/vitest/vitest.mjs run` · tsc `node_modules/typescript/bin/tsc --noEmit`.

## Data reality (from recon — do NOT fabricate beyond this)

- The sim tracks ONE conversation at a time (`this.latestConversation`). There is NO list of concurrent conversations. So the design's "multi-thread feed of all conversations" is honestly served by the **event log** (cross-agent activity: turn/speech/economy/etc. lines). Do NOT invent multiple concurrent threads. The Active-conversation card shows the current gathering + the latest conversation thread.
- Party/gathering data: `controls.attendanceSnapshot(controls.showcaseEventId())` → `buildPartyPanel(snap, arrivedNames, townSize)` → `{ description, host, knowLine, invitedCount, arrivedCount, ... }`.
- Conversation thread: `this.latestConversation` → `buildTranscript(conv, maxLines, clip)` → `{ participants, lines, empty }`.
- Event log: `this.feed.list(n)` → `formatFeedItem(item, maxChars)`; EventKind→dot-color map already exists in `src/obs/EventLog.ts`.
- Governance: `controls.governanceTally()` → `buildGovernancePanel(tally, town)` — a shipped HOM feature NOT in the SpaceCon design. PRESERVE it (see below).

## Design target (README §5 — pure Phaser, theme.ts tokens)

The DEFAULT rail is two stacked cards (`card` bg #111c30, `borderCard` #1f2c46, radius ~14, padding ~16×17) in the right rail (width `rightW`, ~360px).

**1. Active-conversation card** (top):
- Mono uppercase header (e.g. "ACTIVE CONVERSATION").
- ★ (`brand400`) + title (the gathering `description`, e.g. "A gathering at the tavern") + sub "host {name} · day N {phase}".
- Three mini-stat tiles (inset `insetTile` bg): Know `N/M` · Invited `K` (`brand400`) · Arrived `J` (`positive500`).
- A labeled chat thread: host messages left-aligned bubbles (`#16243c`, radius 10/10/10/3), the other speaker right-aligned (`#1d2336`, radius 10/10/3/10), max-width ~88%, body font. (Bubble corner-radius nicety is optional in Phaser — a left/right aligned tinted rect + text is acceptable; note if simplified.)
- When there is NO active gathering but there IS a conversation: show the conversation thread with its participants as the title. When NEITHER: a calm empty state ("No active conversation").
- **Source the gathering stats from buildPartyPanel and the thread from buildTranscript** — real data only.

**2. Event log card** (bottom): the existing feed, restyled SpaceCon:
- Mono uppercase header ("EVENTS").
- Rows: `time` (mono ~10.5px `ink500`, fixed width) + a colored DOT (by event kind, reuse the EventLog color map) + `who` (white 500) + `what` (`ink200`/ink300). Newest-first, the existing cap. Keep the existing turn-line click→trace behavior (clicking a turn row opens the inspector).

**Governance preservation:** keep the governance proposal visible — fold it into the Active-conversation card region as a compact proposal line/sub-card when a tally is open (⚖ ruleText · Yes/No · aware), OR as a distinct event-log entry. Do NOT remove the governance display. State your choice.

## Layout (`src/obs/layout.ts`)

- Consolidate the current `partyRect` + `transcriptRect` into ONE `activeConvRect` (the Active-conversation card) occupying the upper portion of the right rail; the `logRect` (event log) stays docked at the bottom. Keep `panelRect` (the trace panel overlay) for the INSPECTOR state (B-7). Update the rail region math + `HudLayout` fields accordingly; keep `rightRect`, `logRect`, `panelRect` consumers working.
- Integers + rule-14 (≥12px). Keep the click-through guard (`isPointOverHud` / `publishPanelRect`) correct for the new regions.

## Tests

- Update `tests/obs/layout.test.ts` for the consolidated rail regions (activeConvRect within the rail, above logRect; logRect unchanged at bottom; panelRect still overlays). Assert the new exact regions with equal-or-greater strictness; keep hit-testing + the existing event-log/transcript/party model tests (eventlog/partyPanel/transcript/governancePanel) GREEN — those test the MODELS (unchanged), not the draw.
- Do NOT weaken the model tests; if the active-conv card reuses buildPartyPanel/buildTranscript/buildGovernancePanel, those models stay as-is.

## Hard gates (verify must check ALL)

- Full suite green + `tsc --noEmit` clean.
- DEFAULT rail shows the Active-conversation card (real gathering+thread data) + the Event log (real feed); governance preserved.
- No fabricated data: single-conversation reality respected; empty states are honest; no invented concurrent threads or fake stats.
- INSPECTOR state (selected agent → trace panel) still works (unchanged this slice); selecting/deselecting swaps DEFAULT↔trace.
- Tokens single-source (no new SpaceCon hex outside theme.ts; the bubble tints `#16243c`/`#1d2336` are new — ADD them to theme.ts as tokens, do not hardcode); world rendering + determinism untouched.
- No gamed gate: layout.test reflects the real region consolidation with equal-or-greater strictness; model tests unchanged; no unrelated assertion weakened.

## File ownership
A SINGLE implement agent owns: `src/scenes/UIScene.ts`, `src/obs/layout.ts`,
`src/obs/theme.ts` (ONLY to ADD the two bubble-tint tokens — do not change existing values),
`tests/obs/layout.test.ts`, and `tests/obs/theme.test.ts` (to pin the 2 new tokens).
Do NOT change the obs MODEL modules (partyPanel/transcript/eventlog/governancePanel) or their tests, `src/world/`, or `config.ts`.
