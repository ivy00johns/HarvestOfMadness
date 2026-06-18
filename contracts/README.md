# Harvest of Madness — Contracts (v2.1)

> **Wave 4b (multi-hop gossip, additive):** `MemoryEntry` gains optional `origin?: string` (stable first-hand source memory id) + `hop?: number` (relay distance, hop 1 = direct) — both absent on non-gossip memories; drives bounded multi-hop relay with origin-dedup, hop cap, and belief decay in src/agents/Cognition.ts.

> **Wave 4a (emergent roles, additive):** `ROLE_VOCABULARY` + `DerivedRole`
> (farmer/merchant/socialite/wanderer/banker) — roles are DERIVED at runtime
> from the action histogram (src/agents/Roles.ts), never seeded.
> `Observation.self.role` stays typed `string` (no narrowing); optional
> `AgentCardModel.role` added. Advisory only — colors decisions, never overrides.

> **v2.1 (M0 — LLM resilience, additive):** prep for the Smallville-scale build
> (plans/cozy-toasting-russell.md). ADDITIVE only: `maxTokens` on
> LlmRequest/CompleteRequest (decision retry boosts it on length/truncation);
> `bouncedFrom`/`bouncedTo`/`finishReason` on LlmResponse/CompleteResponse
> (records a single-shot `model:auto` backup + drives client truncation
> handling). No breaking changes. The full world-model/hierarchical-plan
> overhaul lands as v3.0 in M1.

> **v2.0 (deep-research-v2: cognition + real art):** implements
> docs/deep-research-v2.md Stages 1–2 on top of the v1 harness. ADDITIVE:
> new ActionTypes `GIVE_GIFT`/`EMOTE` (+energy rows, +§4.4 rows below); new
> cognition seams (MemoryStore / retrieval / ReflectionEngine / Planner /
> RelationshipStore); `POST /api/embeddings`; optional `tier` on complete;
> optional fields on Observation/AgentAction/AgentCardModel/RenderApi.
> CHANGED: `TILE_SIZE` 16→32 (LPC art). Asset truth is
> `public/assets/manifest.json` (AssetManifest type); placeholder graphics
> remain the mandatory no-assets fallback. v1.2 note kept below for history.

> **v1.2 (kickoff constants):** docs/kickoff-fable5.md "Simulation constants
> (authoritative)" incorporated: STARTING_GOLD 200, STARTING_SEEDS 5 (parsnip),
> potato seedCost 40, per-action ENERGY_COSTS (TILL 2 / PLANT 1 / WATER 1 /
> HARVEST 2 / others 0, replaces ENERGY_COST_FIELD), PHASE_DURATION_MS 8000
> (~32s in-game day), mock farmer follows the kickoff 9-step priority ladder.
> Interface precedence per that doc: §4.4 stands, so SLEEP stays night-gated
> (mock emits SLEEP only at night) and energy-0 keeps SLEEP legal at bed
> (else an exhausted agent at bed deadlocks). itemId format stays
> `seed:<kind>`/`crop:<kind>` (contract-pinned before the kickoff landed;
> kickoff's `parsnip_seed` is the same semantics, different spelling).

Authoritative seams for the multi-agent build. `contracts/types.ts` is the
single shared types file; `contracts/openapi.yaml` is the proxy wire contract.
Mission interfaces (docs/deep-research-v1.md §4/§6/§7/§11) are reproduced
verbatim in types.ts — do not drift from them.

**Read-only after Phase-4 sign-off.** Changes go through the orchestrator:
pause → update → bump version → notify affected agents → confirm.

## Conventions

- Language: TypeScript everywhere, camelCase on every wire and in every file
  (no snake_case transform exists in this project).
- Client imports contract types via the path alias `@contracts/types`
  (configured in root tsconfig + vite config by the scaffold).
- Proxy base URL: `http://localhost:8787`; Vite dev server on **5175**
  (5173/5174 are occupied by other running projects) with `/api` proxied to
  8787. No trailing slashes. JSON only.
- IDs: agent names are unique strings; `turnId` = `${agentName}-${counter}`.
- Item ids: `seed:<cropKind>` and `crop:<cropKind>`.

## Endpoint quick reference

| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | liveness + upstream status + budget counters |
| POST | /api/agent/complete | one decision completion via FreeLLMAPI (v2: optional `tier`) |
| POST | /api/embeddings | v2: batch embeddings for memory retrieval (≤32 texts) |

Upstream: running FreeLLMAPI at `http://127.0.0.1:3001` (Docker), OpenAI-compatible
`POST /v1/chat/completions`, auth `Authorization: Bearer $FREELLMAPI_API_KEY`,
`model: "auto"`, actual servicing model in `X-Routed-Via` response header.
**The key lives ONLY in `server/.env`. It must never appear in any file under
`src/` or in the Vite bundle.**

## Domain rules (cross-agent invariants)

1. **Reject loudly, never crash** — every invalid `AgentAction` produces
   `{ok:false, reason}` surfaced via `Observation.lastAction` next decision.
   §4.4 precondition table is authoritative; `ActionExecutor` implements it.
2. **SLEEP is the only day advance** — `WorldApi.advanceDay()` owns: next
   morning, +1 stage for watered crops, watering reset, energy restore (to
   100) is applied by the executor, not the world.
3. **Energy floor** — at energy 0 only MOVE_TO (toward bed), SLEEP, WAIT are
   available; `Observation.availableActions` must reflect this.
4. **Async, no global tick** — agent FSM `IDLE → THINKING → EXECUTING → IDLE`;
   world rendering never awaits a decision. Validation happens against
   *current* world state when the LLM response returns.
5. **Opt-in budget kill-switch** — both ceilings (`maxDecisionsPerDay` client,
   `DAILY_CEILING` server) default to **unlimited** (`<= 0`), since FreeLLMAPI
   tokens are free. If you set a positive cap, past it the AgentManager switches
   that agent to the mock heuristic router and emits a `budget_reached` event;
   the HUD shows a "budget reached" badge. (Genuine upstream exhaustion is a
   separate, always-on path: a `rate_limit_error` 429 drives the `LLM OFFLINE`
   kill-switch with auto-recovery.)
6. **Prompt contract** — system prompt ends with: respond with ONLY one JSON
   object, no prose, no fences. Parsing is always defensive (strip fences,
   first `{...}` block) regardless.
7. **Mock-first** — `getRouter()` returns mockRouter unless
   `VITE_MODEL_MODE=live`. The game must be fully playable with the server
   down and zero image assets.

### v2 domain rules (cognition + art)

8. **§4.4 additions** — `GIVE_GIFT`: target agent must be 4-adjacent, itemId
   in giver's inventory with qty ≥ 1; transfers 1 item giver→receiver,
   records a high-importance memory for BOTH and a `recordInteraction` for
   each direction. `EMOTE`: always legal, no world mutation, renders only.
9. **Memory write discipline** — every resolved action, received utterance,
   gift, and observation of another agent's activity becomes an
   `observation` memory. Importance: live = fast-tier 1–10 rating; mock =
   heuristic (gift/harvest-fail 7, talk 5, routine farm action 2).
10. **Retrieval scoring is the contract formula** — equal weights, decay
    0.995/game-hour, top-5; relevance term is 0 when embeddings are missing
    (offline/mock). NEVER block a decision on the embeddings endpoint:
    embedding writes are fire-and-forget, retrieval uses what's there.
11. **Reflection cadence** — threshold 30 summed importance (≈2–3×/day),
    smart tier, insights must cite `sourceIds`. Mock mode produces a
    templated reflection so the pipeline is testable at $0.
12. **Morning planning** — at each `day_advanced`, every agent gets a 4-step
    DailyPlan (one step/phase) before its first decision of the day; the
    current step rides in `Observation.self.currentPlanStep`.
13. **Kill-switch visibility (the demo's thesis)** — when live routing fails
    or mode=mock, the HUD must show an explicit "LLM OFFLINE — canned
    behavior" state and agents visibly degrade to the heuristic. Dialogue,
    planning, reflection, and relationship summaries ALL route through the
    LLM in live mode so the difference is undeniable.
14. **Readable text** — minimum effective font size 12px at zoom 1, integer
    pixel positions, `roundPixels: true`. The v1 6px-HUD failure must not
    recur; render-sanity checks this explicitly.
15. **Asset fallback** — BootScene tries `assets/manifest.json`; on 404 or
    parse error it logs ONE warning and uses v1 placeholder graphics. No
    code path may hard-require an image file.
16. **License hygiene** — every shipped asset is enumerated in CREDITS.txt
    (author, license, URL, modifications). No Sprout Lands / Cute Fantasy /
    non-redistributable files in the repo, ever.

## File ownership — v2 build (supersedes the v1 table for new work)

| Agent (role) | Owns |
|---|---|
| asset-agent (vW0) | `public/assets/**`, `CREDITS.txt`, `scripts/assets/**` |
| server-llm-agent (vW1) | `server/**`, `src/llm/**` (embeddings proxy, tier mapping, v2 prompts: importance/reflection/planning/dialogue + mock equivalents) |
| render-agent (vW1) | `src/scenes/**` (Boot/World — NOT UIScene), `src/world/render.ts`, `src/world/map.ts` (decor layers only; logical layout is contract-frozen), `scripts/map/**`, `src/config.ts` |
| cognition-agent (vW2) | `src/agents/**` (memory/, reflection, planner, relationships, executor + runtime v2) |
| obs-agent (vW2) | `src/obs/**`, `src/scenes/UIScene.ts` |
| qe-agent (vW3) | `tests/**`, `coordination/qa-report.json` |
| nobody | `contracts/**` (read-only), `docs/**` |

### v1 ownership (historical)

| Agent (role) | Owned |
|---|---|
| scaffold-agent (W0) | repo root: package.json, tsconfig*, vite.config.ts, index.html, .env.example, README.md skeleton, PROVENANCE.md skeleton, vitest.config.ts |
| llm-agent (W1) | `server/**`, `src/llm/**` (router seam, mockRouter heuristic, prompts) |
| world-agent (W1) | `src/world/**`, `src/scenes/BootScene.ts`, `src/scenes/WorldScene.ts`, `src/main.ts`, `src/config.ts` |
| agents-agent (W2) | `src/agents/**` |
| obs-agent (W2) | `src/obs/**`, `src/scenes/UIScene.ts` |
| qe-agent (W3) | `tests/**`, `coordination/qa-report.json` |
| nobody | `contracts/**` (read-only), `docs/**` |

`package.json` dep additions after W0 go through the orchestrator.

## Cross-cutting assignments

- Error envelope + key secrecy + budget counter → llm-agent (server side).
- Mock heuristic quality (must run the full farm loop) → llm-agent.
- Tilemap codegen + placeholder graphics fallback → world-agent.
- Observation assembly + executor effects (energy, gold, inventory) → agents-agent.
- Event emission discipline (every decision = turn_start → llm_call →
  action_chosen → action_resolved under one turnId) → agents-agent emits,
  obs-agent consumes; shapes in types.ts.
- Pause/Step/Speed controls → obs-agent (UI) calling AgentManager API (agents-agent).

## Per-agent implementation notes

- **llm-agent**: Express 4 + node 20, `tsx` for dev. Vendor (with PROVENANCE
  entries) FreeLLMAPI's `lib/error-redaction.ts` and `lib/content.ts` patterns
  for sanitized errors/content coercion. Token fields from upstream `usage`
  (`prompt_tokens`→tokensIn, `completion_tokens`→tokensOut). mockRouter is a
  deterministic state machine that plays competently (till→plant→water→sleep→
  harvest→sell, buys seeds when out) so the $0 demo is judgeable.
- **world-agent**: Phaser 4, code-generated tilemap (no Tiled file), colored
  rects + labeled circles via Graphics when `public/assets/` is empty. Expose
  exactly `WorldApi`. Include a dev "scripted demo" toggle proving the loop
  without agents.
- **agents-agent**: port PDoM patterns — one parse retry with the validation
  error appended, then WAIT + `parse_failure` event; decision trace fields in
  the same single response; per-agent cooldown + global in-flight semaphore.
- **obs-agent**: ring buffer cap 1000; agent cards re-render on event, not per
  frame; expandable trace shows raw observation + raw response verbatim.
- **qe-agent**: Vitest; cover executor preconditions (every §4.4 row), crop
  growth/sleep semantics, scheduler cap/cooldown/ceiling, mock-mode multi-day
  integration run (fake timers), router parse defensiveness.
