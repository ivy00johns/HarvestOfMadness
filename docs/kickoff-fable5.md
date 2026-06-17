# Harvest of Madness — Fable 5 One-Shot Kickoff

**Use this instead of the kickoff prompt in `deep-research-v1.md`.** It targets a single-shot
Fable 5 run with no access to external repos. It keeps the architecture/interfaces from the
research doc (§4 agent contract, §6 async scheduling, §11 router seam, §18 DoD) and overrides the
vendor-and-refactor framing (§0/§3/§14/§15) that a one-shot can't use. It also pins the simulation
constants the research doc left implicit, so the self-running loop cannot deadlock.

> Read `deep-research-v1.md` for full interfaces (§4 Observation/AgentAction/ActionExecutor, §6
> async FSM + cost constants, §8 observability, §9 personas, §11 Router seam, §18 Definition of
> Done). This file is the authoritative kickoff + the constants block. Where the two disagree on
> *harness* (vendoring, provenance, phases), this file wins. Where they disagree on *interfaces*,
> the research doc wins.

---

## Kickoff prompt

Build **Harvest of Madness** as a complete, self-contained repo from this spec.
**Reimplement every module from scratch to the interfaces in §4, §6, and §11 — do not reference,
vendor, or assume access to any other repo.** Ignore the §0/§3/§15 provenance/vendoring plan
entirely; produce no `PROVENANCE.md` and no `vendor/`.

**Stack:** Vite + TypeScript + **Phaser 3** (stable, well-known API). Render the world with
**Phaser Graphics only** — colored rects for tiles, labeled circles for agents. Ship **zero image
files**. Art is a later swap-in; do not block on it.

**The single hard requirement (the gate):** `npm install && npm run dev` boots a window where
**2–3 agents driven by `mockRouter` autonomously run till → plant → water → sleep → harvest → sell
across multiple in-game days, gold changes, and nothing crashes.** Build inward from this. If
anything is at risk, cut scope to protect this.

**Build order — each phase independently runnable:**

1. **World engine** — `Grid` / `Tile` / `TimeSystem` / `Economy` / `Pathfinding` (A*) +
   Graphics render + HUD clock. Prove the loop with a hardcoded script
   (till→plant→water→sleep→harvest→sell) before any agent exists.
2. **Agent layer** — async per-agent FSM (§6: `IDLE → THINKING → EXECUTING → IDLE`, in-flight cap,
   per-agent cooldown), `Observation` / `ActionSchema` / `ActionExecutor` (§4), driven by
   `mockRouter`. **← MVP: self-running farm, $0.**
3. **Observability** (§8) — per-agent inspector cards (name · gold · energy · goal · last thought ·
   last action ± ok/fail · model · latency · tokens · decision count + expandable trace) + global
   event-log ring buffer + pause / step / speed.
4. **Live mode as a STUB** — `liveRouter` POSTs to `/api/agent/complete` with the §11 contract; an
   Express handler returns a well-formed mock `LlmResponse`. Wire the `VITE_MODEL_MODE` switch and
   keep keys server-side only — but **do not require a real provider to function.** Real provider
   wiring is out of scope for this run.
5. **Personas + polish** (§9) — Diligent Dora, Reckless Rusty, Social Sage; speech bubbles; energy
   pressure.

Honor the §4/§6/§11 interfaces exactly and the **Simulation constants (authoritative)** below
**verbatim** — they are tuned so the loop cannot deadlock. When this spec is silent, pick the
simplest choice that keeps mock mode self-running, and leave a `// TODO` rather than adding scope.
Do not stop to ask; produce the whole repo, then self-check the gate.

---

## Simulation constants (authoritative)

These fill the gaps the research doc left implicit. They are chosen so the full loop is always
reachable from the start state.

**Agent start state**
- 200 gold · 100 energy · inventory `[{ itemId: "parsnip_seed", qty: 5 }]`
- spawn near the farmhouse, within a few tiles of tillable soil.

**Prices** — resolves the `20/35` ambiguity as **seed *buy* cost / crop *sell* price**:

| Crop        | Seed buy | Crop sell | Days to grow |
|-------------|----------|-----------|--------------|
| parsnip     | 20       | 35        | 4            |
| potato      | 40       | 80        | 6            |
| cauliflower | 80       | 175       | 8            |

Shop **sells seeds** and **buys crops**, at the `shopTile` only. BUY/SELL require the agent to be
at the shop with sufficient gold / matching inventory.

**Crop stage model**
- Stage count = days to grow: parsnip 4 · potato 6 · cauliflower 8.
- Each **SLEEP** with `watered === true` advances the crop stage by **+1** and resets
  `watered = false`.
- An **unwatered** crop does **not** advance on SLEEP.
- At the final stage, `ready = true` → eligible for HARVEST.

**Energy costs** (replace the "~2–5" range with fixed values)

| Action  | Energy |
|---------|--------|
| TILL    | 2      |
| PLANT   | 1      |
| WATER   | 1      |
| HARVEST | 2      |
| MOVE_TO | 0      |
| others  | 0      |

- At energy 0, only `MOVE_TO(bed)` and `WAIT` are legal.
- **SLEEP** restores energy to 100 and advances the calendar day.

**Mock farmer decision priority** — `mockRouter` returns a valid `AgentAction` (§4.3). First legal
action in this order wins; deterministic given an identical observation:

1. `ready` crop adjacent → **HARVEST**
2. holding a harvestable crop and at/adjacent to shop → **SELL**
3. tilled & empty tile adjacent and has a seed → **PLANT**
4. unwatered crop adjacent and energy > 0 → **WATER**
5. untilled soil adjacent and energy > 0 → **TILL**
6. energy 0, or phase = night, and at bed → **SLEEP**
7. out of seeds and gold ≥ a seed cost → **MOVE_TO(shop)** then **BUY**
8. otherwise → **MOVE_TO** the nearest actionable tile (untilled soil → tilled empty → unwatered
   crop → ready crop, whichever is closest)
9. otherwise → **WAIT**

**Clock**
- N phase-ticks per phase (morning/afternoon/evening/night); **SLEEP** advances the day.
- Pick N so one in-game day is ~20–40s in mock mode — fast enough to watch multiple days quickly.

---

## Why this differs from `deep-research-v1.md`

- **No vendor/refactor, no provenance.** A one-shot has no access to PDoM or FreeLLMAPI; those
  sections (§0/§3/§14/§15) cost budget and produce no game code. Everything is reimplemented to the
  same interfaces.
- **Mock mode is the gate, live mode is a stub.** Real free-tier providers are the flakiest, most
  failure-prone surface; requiring them turns a one-shot into a coin-flip. The §11 seam and
  `VITE_MODEL_MODE` switch are still built so real wiring is a drop-in later.
- **Phaser 3, Graphics-only.** Avoids Phaser 4 API drift and any asset dependency — the two most
  common one-shot crash sources.
- **Constants pinned.** Start seeds, price semantics, crop stages, energy costs, and the mock
  decision order were implicit in the research doc; without them the loop can deadlock (no seeds →
  no PLANT) or the economy is guessed wrong. They are now authoritative.
