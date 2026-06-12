# Harvest of Madness — Contracts (v1.2)

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
| POST | /api/agent/complete | one decision completion via FreeLLMAPI |

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
5. **Budget kill-switch** — past `maxDecisionsPerDay` (client) or
   `DAILY_CEILING` (server 429 `budget_exceeded`), the AgentManager switches
   that agent to the mock heuristic router and emits a `budget_reached` event;
   the HUD shows a "budget reached" badge.
6. **Prompt contract** — system prompt ends with: respond with ONLY one JSON
   object, no prose, no fences. Parsing is always defensive (strip fences,
   first `{...}` block) regardless.
7. **Mock-first** — `getRouter()` returns mockRouter unless
   `VITE_MODEL_MODE=live`. The game must be fully playable with the server
   down and zero image assets.

## File ownership

| Agent (role) | Owns |
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
