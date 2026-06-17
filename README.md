# Harvest of Madness

Harvest of Madness is an AI-driven, Stardew-like farming sim you *watch* rather than play. A small cast of LLM-driven agents wakes up on a tiny pixel farm, observes its surroundings, and decides — one JSON action at a time — when to till, plant, water, harvest, trade, gossip, and sleep. Every decision is fully inspectable: the raw observation sent to the model, the raw response, latency, tokens, and the validated outcome are all surfaced in an in-game inspector.

The build is mock-first and costs $0 by default: a deterministic heuristic router plays the entire farm loop with no server, no API key, and no image assets. Flip `VITE_MODEL_MODE=live` and a thin Express proxy routes real decisions through a local [FreeLLMAPI](https://github.com/) instance with a hard daily budget ceiling, so live mode stays free too.

## Quick start

```sh
npm install
npm run dev
```

Then open http://localhost:5175. The `dev` script runs the Vite client (port 5175) and the Express proxy (port 8787) together with prefixed output; `/api` requests are proxied from the client to the server.

Other commands:

| Command | What it does |
|---|---|
| `npm run dev:client` | Vite dev server only (5175, strict port) |
| `npm run dev:server` | Express proxy only (`tsx watch server/index.ts`) |
| `npm run build` | `tsc -b && vite build` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |

## Environment

Copy `.env.example` to `.env` (client) and `server/.env` (server). The FreeLLMAPI key lives **only** in `server/.env` — never in `src/` or the Vite bundle.

| Var | Default | Scope | Purpose |
|---|---|---|---|
| `VITE_MODEL_MODE` | `mock` | client | `mock` = heuristic router ($0); `live` = call the proxy |
| `PORT` | `8787` | server | Express proxy port |
| `FREELLMAPI_BASE_URL` | `http://127.0.0.1:3001` | server | Running FreeLLMAPI instance |
| `FREELLMAPI_API_KEY` | (empty) | server | Bearer key for FreeLLMAPI |
| `FREELLMAPI_MODEL` | `auto` | server | Model id; `auto` lets FreeLLMAPI route |
| `DAILY_CEILING` | `200` | server | Hard daily decision budget (429 past it) |

## Going live

Mock mode needs nothing. To route real decisions through FreeLLMAPI:

1. **Get the unified key** from the FreeLLMAPI dashboard at http://localhost:3001 (the Docker instance must be running).
2. **Write `server/.env`** (copy `server/.env.example`) with `FREELLMAPI_API_KEY=<your key>`.
3. **Run live:** `VITE_MODEL_MODE=live npm run dev` — or put `VITE_MODEL_MODE=live` in `.env` and just `npm run dev`.

Self-verify with `GET http://localhost:8787/api/health` (`curl -s localhost:8787/api/health`):

| `upstream` value | Meaning |
|---|---|
| `unreachable` | FreeLLMAPI itself is down — start the Docker instance |
| `unauthorized` | reachable, but the key is missing/invalid — finish step 2, restart the proxy |
| `ok` | ready — live decisions will flow |

Expected progression: `unauthorized` (fresh checkout, no key) → `ok` (after steps 1–2). Then `npm run live:smoke` (with the proxy running) sends one real canned-observation decision through the proxy and prints model / latency / tokens and the parsed action; it exits non-zero with a pointed message if the key is still missing. Past `DAILY_CEILING` decisions in a UTC day the proxy returns 429 `budget_exceeded` and agents fall back to the mock heuristic.

## Repo map

```
contracts/        frozen shared types + OpenAPI proxy contract (read-only)
docs/             mission doc (deep-research-v1.md)
src/main.ts       Phaser bootstrap (stub until world engine lands)
src/world/        grid, time, economy, pathfinding (world-agent)
src/agents/       async sense→think→act pipeline (agents-agent)
src/llm/          router seam: mock heuristic + live proxy client (llm-agent)
src/obs/          event log + inspector data model (obs-agent)
server/           Express proxy holding the FreeLLMAPI key (llm-agent)
tests/            vitest suites
public/assets/    optional art; code-drawn placeholders are the fallback
```

Engine: **Phaser 4** (`phaser@^4.1.0`, the current stable npm release). Stack: Vite + TypeScript, Express 4, Vitest.

## Borrowed DNA

Parts of the server router and the agent decision pipeline are vendored/refactored from prior projects (FreeLLMAPI, Petri Dish of Madness). See [PROVENANCE.md](./PROVENANCE.md) for the source → target map and refactor notes.
