# Harvest of Madness v2 — Build Results

Branch: `feat/harvest-of-madness-v2` (off v1 head; **not merged, not pushed**)
Mission: docs/deep-research-v2.md · Stages 1–2 · evolve-v1 · full LPC
Date: 2026-06-12

## What shipped

| Area | Commit | Summary |
|---|---|---|
| Contracts v2.0 | ec68501 | Cognition seams (memory/retrieval/reflection/planning/relationships), GIVE_GIFT/EMOTE, /api/embeddings, fast/smart tiers, AssetManifest, rules 8–16 |
| Server + LLM | cea3e87 | Embeddings proxy (no budget consumption), tier→model mapping, v2 prompt builders, mock counterparts, embedTexts/cosine |
| LPC assets | c94c400 | 976KB: 5 walk-cycle characters, 9 tilesets, 4 crop strips (5 stages), manifest.json, CREDITS.txt (CC-BY-SA/GPL/OGA-BY, no non-redistributables) |
| Observability HUD | 21409ca | All five v1 UX defects fixed; 12px+ fonts; turn-collapsed feed + day separators; LIVE/OFFLINE/MOCK kill-switch badge; affinity meters; M:/R: counters |
| Cognition | 12e263a | Park-style memory stream (decay 0.995, fire-and-forget embeddings), reflection (threshold 30, sourceIds, cap 3/day), 4-step daily plans, asymmetric relationships, six personas |
| Rendering | 5b9e8bf | Real LPC art with rule-15 placeholder fallback, neighbour-mask shores/fields, animated water, crop growth sprites, 4-dir walk anims, emotes/bubbles |
| QE gate | 5ebc2d0 | 59 adversarial cross-agent tests; qa-report proceed=true |

## Gate results (all passed)

- **Typecheck** clean · **tests 543/543** (0 skips) · **vite build** green.
- **QA gate**: proceed=true; contract_conformance 5, integration 5, security 5,
  regression 5, v2_coverage 4; 0 blockers; `dist/` greps clean of every key shape.
- **render-sanity (haiku)**: PASS 7/7 — real art (not v1 rects), animation alive,
  rule-14 readable text, click-through, day rollover, rule-15 fallback round-trip,
  zero console errors.
- **ux-review + live verify (sonnet)**: all 5 v1 defects fixed at pixel level.
  Live mode proven: 6 distinct real models (mistral-small, cohere command-a ×2,
  glm-4.6v-flash, poolside laguna, codestral) with real tokens/latencies;
  persona-coherent quoted thoughts; situational dialogue; real reflection
  synthesis. A FreeLLMAPI free-tier 429 cascade at ~3min correctly flipped the
  badge to "LLM OFFLINE — canned behavior" with no freeze — the kill-switch
  thesis demonstrated both directions.

## Recorded (not fixed) — post-build backlog

From ux-review, ranked:
1. **(Critical for demos)** 429 cascade fills traces with "PARSE FAIL — unknown";
   label rate-limited turns "· rate-limited" in the trace summary.
2. Kill-switch badge is centered/small; pin top-left or bump to 15px bold.
3. Compact card meta row illegible; render model name larger/colored, drop
   latency/tokens in compact mode.
4. Speech bubbles lack a swatch-colored leader/corner tying bubble→card.
5. Trace panel opens fully collapsed; auto-expand the newest entry
   (`expandedTurnIds.add(entries[0].turnId)` before `layoutPanel()`).

From QE (MINOR): `Reflection.reflectLive` lacks try/catch (unreachable with
conforming routers); single 1.7MB Phaser chunk (carried from v1).
Cosmetic: cauliflower renders via turnip strip alias; manifest ships unused
carrot strip.

## How to run

- Mock ($0, deterministic): `npm run dev` → http://localhost:5175
  (badge: MOCK MODE). **A mock stack is still running: PID in /tmp/hom-dev-v2.pid
  — stop with `kill $(cat /tmp/hom-dev-v2.pid)`.**
- Live: set `VITE_MODEL_MODE=live` in `.env` (or env-override) and restart vite;
  server proxy + FreeLLMAPI (127.0.0.1:3001) must be up. Budget: 200
  decisions/UTC-day server ceiling; ~4–5 smart calls/agent-day cognition
  overhead; 6 agents ≈ 144 calls/game-day total.
- Kill-switch demo: stop the FreeLLMAPI container (or wait for free-tier 429s) —
  badge flips to LLM OFFLINE, NPCs degrade to canned heuristics, world keeps
  running; recovery flips it back on the next successful decision.

## Handoff items for John

1. Branch stays unmerged until you say so.
2. The five UX polish items above are one small obs/render wave if wanted.
3. CC-BY-SA obligation: keep CREDITS.txt in any public distribution; derivative
   art must stay CC-BY-SA (code unaffected).
4. Free-tier 429s are the main live-demo risk; mitigations if needed: raise
   per-agent cooldown, lower agent count, or add paid keys to FreeLLMAPI's pool.
