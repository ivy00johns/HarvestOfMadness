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
- [x] `use-freellmapi` — invoked at W3. Wiring verified (proxy healthy, env-toggle
  pattern in server/.env.example, `npm run live:smoke` test path). Unified key
  recovered via the skill's sanctioned container-log method; the WRITE of the
  key to server/.env was blocked by the permission classifier pending explicit
  user authorization — final live test call is HITL: user writes server/.env
  (or authorizes the write), then `npm run live:smoke`. ✅ (with HITL remainder)

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
0. **docs/kickoff-fable5.md incorporated mid-build (2026-06-11, contracts v1.2).**
   Adopted in full: the authoritative simulation constants (gold 200, 5 seeds,
   potato 40g, per-action energy costs, ~32s day), the 9-step mock priority
   ladder, clock pacing. NOT adopted (with reasons): Phaser 3 downgrade (Phaser
   4.1 already installed, browser-verified, W1-gate green — the kickoff's
   rationale was API-drift risk in a *blind* one-shot); dropping PROVENANCE/
   vendoring (already done and costless; user's original instruction was
   vendor-and-refactor with both source repos available); live-mode-as-stub
   (real FreeLLMAPI wiring exists per user's explicit "FreeLLMAPI is running
   now" and already degrades to a graceful 401 stub without a key). Interface
   conflicts resolved per the kickoff's own precedence rule (research doc wins
   on interfaces): SLEEP stays night-gated; energy-0 keeps SLEEP legal at bed.
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
