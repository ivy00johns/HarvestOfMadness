# PROVENANCE

Map of every borrowed/vendored module: where it came from, where it landed,
and how it was refactored. Implementation agents append a row whenever they
lift code. Source repos:

- FreeLLMAPI — `/Users/johns/Repos/the-hive-ecosystem/freellmapi`
- Petri Dish of Madness (PDoM) — `/Users/johns/Projects/petri-dish-of-madness`

| Source | Module | Target | Refactor notes |
|---|---|---|---|
| FreeLLMAPI | `server/src/lib/error-redaction.ts` (`sanitizeProviderErrorMessage`) | `server/llm/redact.ts` (`sanitizeErrorMessage`) | W1 (llm-agent): vendored the full REDACTIONS table (Bearer/sk-/gsk_/freellmapi-/AIza/JWT/URL patterns), whitespace collapse, 240-char cap; renamed export, default message "Upstream error"; applied to every ApiError envelope the proxy emits |
| FreeLLMAPI | `server/src/lib/content.ts` (`contentToString`) | `server/llm/content.ts` | W1 (llm-agent): vendored only `contentToString` (string/null/array-of-blocks → string, accepts typeless `{text}` Gemini-style blocks); dropped flatten/image/outbound-normalize helpers and the `@freellmapi/shared` type import — used to coerce upstream `choices[0].message.content` into `CompleteResponse.raw` |
| PDoM | `backend/petridish/agents/runtime.py` (`run_turn`: parse → ONE retry with the validation problem appended → second failure = idle + `parse_failure` event; ProviderError = failed turn, no retry) | `src/agents/AgentRuntime.ts` | W2 (agents-agent): ported the retry-once discipline — retry user prompt appends the parse problem + a "reply must begin with {, JSON only, fallback WAIT" instruction (PDoM's retry message verbatim in spirit); second failure → WAIT + `parse_failure`; router errors degrade to WAIT without retry; tick barrier stripped, fully async per mission §6 |
| PDoM | `runtime.py` per-turn trace metadata captured in the SAME single response (EM-066/EM-067: `llm_attempts` list, one `llm_call` span per attempt under one turn id) | `src/agents/AgentRuntime.ts` (`llm_call` event per attempt, `DecisionTraceEntry` per decision) | W2: every router attempt (incl. the retry and the budget-fallback re-call) emits its own `llm_call` event under the same `turnId`; trace entry (observationJson/rawResponse/parsedOk/model/latency/tokens) stored newest-first on the agent, cap 20 — shapes per contracts/types.ts §8 |
| PDoM | global-round scheduler concept (round-robin due turns) | `src/agents/AgentManager.ts` | W2: replaced PDoM's global tick/round loop with per-agent `IDLE → THINKING → EXECUTING → IDLE` loops (mission §6): per-agent cooldown ÷ speed, global in-flight semaphore held during THINKING only, manager-level daily decision ceiling → mock heuristic fallback + one `budget_reached` event |
| PDoM | decision-pipeline observability patterns (`turnId` span chain) | `src/obs/*` | pending W2 (obs-agent): consumes the event shapes in contracts/types.ts |

Engine note: Phaser 4 (`phaser@^4.1.0`) is published and stable on npm, so the
scaffold uses v4 as the mission prefers (no 3.x fallback needed).
