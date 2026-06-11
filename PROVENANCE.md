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
| PDoM | decision-pipeline patterns: parse-retry-once, `turnId` trace chain, OTel `llm_call` fields | `src/agents/*` + `src/obs/*` | pending W2 (agents-agent + obs-agent): strip the tick barrier, async per mission §6; trace shapes per contracts/types.ts |

Engine note: Phaser 4 (`phaser@^4.1.0`) is published and stable on npm, so the
scaffold uses v4 as the mission prefers (no 3.x fallback needed).
