# PROVENANCE

Map of every borrowed/vendored module: where it came from, where it landed,
and how it was refactored. Implementation agents append a row whenever they
lift code. Source repos:

- FreeLLMAPI — `/Users/johns/Repos/the-hive-ecosystem/freellmapi`
- Petri Dish of Madness (PDoM) — `/Users/johns/Projects/petri-dish-of-madness`

| Source | Module | Target | Refactor notes |
|---|---|---|---|
| FreeLLMAPI | `lib/error-redaction.ts` + `lib/content.ts` error-redaction/content-coercion patterns | `server/llm/*` | pending W1 (llm-agent): sanitize upstream errors into the ApiError envelope; never leak the key |
| PDoM | decision-pipeline patterns: parse-retry-once, `turnId` trace chain, OTel `llm_call` fields | `src/agents/*` + `src/obs/*` | pending W2 (agents-agent + obs-agent): strip the tick barrier, async per mission §6; trace shapes per contracts/types.ts |

Engine note: Phaser 4 (`phaser@^4.1.0`) is published and stable on npm, so the
scaffold uses v4 as the mission prefers (no 3.x fallback needed).
