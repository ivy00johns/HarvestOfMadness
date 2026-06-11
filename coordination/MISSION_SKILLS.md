# Mission skill manifest — Harvest of Madness
Source: docs/deep-research-v1.md · Scanned: 2026-06-11

Every box must end the build either ✅ (invoked, with the artifact path)
or annotated with a one-line reason for deferral. Empty boxes are bugs.

The mission names no skills by slash-name; it names *tools/repos* (Claude Code,
Fable 5, FreeLLMAPI, Petri Dish of Madness). Skills below are the orchestrator's
composition mapped onto the mission's own §14 phase numbering.

## Phase 0 — Scaffold
- [x] `git-commit` — invoked before first commits; conventions applied (branch `feat/harvest-of-madness-v1`). ✅
- [ ] `contract-author` — invoke before any implementation agent; produces `contracts/*`.

## Phase 1 — Router (FreeLLMAPI seam)
- [ ] `use-freellmapi` — invoke when wiring `server/` live mode to the running proxy at `127.0.0.1:3001`; produces verified env wiring + test call.

## Phase 2 — World engine (new)
- (no external skills — greenfield; frontend-agent carries `frontend-design` discipline where DOM UI exists; HUD is canvas-rendered Phaser)

## Phase 3 — Agent pipeline (vendor + refactor PDoM)
- (no external skills — refactor against contracts; PROVENANCE.md updated per lift)

## Phase 4 — Observability
- (no external skills)

## Phase 5 — Live + personas + polish
- [ ] `playwright` / `render-sanity` — post-build outcome gate: boot dev server, walk routes, four objective checks must PASS.
- [ ] `ux-review` — subjective post-build pass on the running sim.
- [ ] `design-token-guard` — expected N/A (Phaser canvas HUD, no CSS token system); confirm and record reason at gate time.

## Cross-cutting
- [ ] `qe-agent` (role) — mandatory; produces `coordination/qa-report.json`.

## Recorded deviations
1. **Vendor → proxy-to-running-instance (FreeLLMAPI).** Mission §3 says vendor
   FreeLLMAPI's pool/route/fallback into `server/llm/*`. The real FreeLLMAPI is a
   full product (encrypted key DB, dashboard, auth) already running in Docker at
   `127.0.0.1:3001`, and the user stated "the FreeLLMAPI is running now". HoM's
   `server/` Express proxy implements the §11 `Router` seam and forwards to the
   running instance (key in `server/.env` only); only parse/normalize/limit
   logic is vendored. All §11 interfaces preserved verbatim. Mock mode remains
   the $0 default so the game runs with FreeLLMAPI down.
2. **`docs/agents/` config absent.** Proceeding with defaults: single-context,
   contract format by detection (TypeScript interfaces), work items in local
   `briefs/`. Run `/setup-project-skills` later to make these durable.

## Environment constraints (Phase 0 audit)
- FreeLLMAPI: Docker `ghcr.io/tashfeenahmed/freellmapi:latest`, `127.0.0.1:3001`,
  health 200, `/v1/*` requires unified API key (OpenAI-compatible).
- Port `8000` is PDoM's backend (uvicorn, --reload); ports `5173`/`5174` are
  occupied by running Vite dev servers → HoM Vite must use `5175` (pin in config).
- PDoM source: `/Users/johns/Projects/petri-dish-of-madness` (note: NOT ../PetriDishOfMadness).
- FreeLLMAPI source: `/Users/johns/Repos/the-hive-ecosystem/freellmapi`.
