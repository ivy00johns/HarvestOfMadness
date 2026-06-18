# Contract — Storage deposit mechanic (Living Homes #2 / Phase D-adjacent)

Single source of truth for the implement agent AND the verify critics. Adds a
FUNCTIONAL home-storage deposit/withdraw mechanic: an agent standing on its bed
tile (its home) can DEPOSIT goods from `inventory` into a per-agent `homeStorage`
and WITHDRAW them back. "If an agent buys/harvests something, it has somewhere to
put it." Mock-first, deterministic (no `Math.random`, no `Date`), additive — every
existing action flow stays intact.

Run tools with the nvm-absolute node:
- tests: `node_modules/vitest/vitest.mjs run <file>`
- full suite: `node_modules/vitest/vitest.mjs run`
- tsc: `node_modules/typescript/bin/tsc --noEmit`

---

## Design (decided — do not re-litigate)

- **Anchor = the bed tile.** DEPOSIT/WITHDRAW gate on `world.getTile(agent.pos).type === "bedTile"` — exactly like SLEEP. No new WorldObject, no `WORLD_OBJECTS` change (keeps `world.objects()` length 4), no render change (the CABINET sprite already renders in every home), no grid mutation, no server change. The cabinet is the visual; the bed tile is the mechanical anchor (same room).
- **State = per-agent `homeStorage: InventoryEntry[]`** on `Agent`, mirroring `inventory`. Persists across day transitions (agents aren't recreated; SLEEP only resets energy). In-memory per session — NO persistence layer (out of scope).
- **Verbs reuse the `{ itemId, qty }` target** (the `isItemTarget` shape BUY/SELL already use). Energy cost 0 (logistics, like BUY/SELL/USE_OBJECT).
- **Mock behaviour = "stash unsold crops before sleeping."** This is the natural moment goods accumulate at home and makes the mechanic visible/believable. Mock EMITS DEPOSIT; mock ACCEPTS but never proactively emits WITHDRAW (same pattern as GIVE_GIFT/EMOTE at mock.ts:61-62 — WITHDRAW is live-LLM + test-driven only for v1).

---

## Exact changes

### 1. `contracts/types.ts`
- `ActionType` union: add `| "DEPOSIT"` and `| "WITHDRAW"` with short comments (`target {itemId, qty}; must stand on your bed tile; moves goods between inventory and home storage`).
- `ENERGY_COSTS` (`Record<ActionType, number>` — tsc REQUIRES entries): add `DEPOSIT: 0, WITHDRAW: 0`.
- `Observation.self`: add `homeStorage?: InventoryEntry[];` (additive optional, documented — surfaced so the live LLM/mock can see what's stored). No other contract field changes. `AgentAction.target` already supports `{ itemId, qty }`.

### 2. `src/agents/Agent.ts`
- Add field `homeStorage: InventoryEntry[] = [];`.
- Add helpers mirroring inventory semantics (same add/remove rules, qty>0 guards, drop-empty-entries):
  - `storageCount(itemId: string): number`
  - `addToStorage(itemId: string, qty: number): void`
  - `removeFromStorage(itemId: string, qty: number): boolean` (false + no-op when short)
- Keep them small and symmetric with `countItem/addItem/removeItem`.

### 3. `src/agents/ActionExecutor.ts`
Add two cases (place after VOTE, before `default`), mirroring the SELL/SLEEP gate style and `reject(...)` with readable reasons:
- `case "DEPOSIT"`: require `isItemTarget(target)` else reject `"DEPOSIT needs an {itemId, qty} target"`; require `world.getTile(agent.pos.x,agent.pos.y)?.type === "bedTile"` else reject `"you must be home (on your bed) to stash goods in storage"`; `gateQty`; require `agent.countItem(itemId) >= qty` else reject `"you have Nx itemId, not qty"`; then `agent.removeItem(itemId, qty)` + `agent.addToStorage(itemId, qty)`; `spendEnergy(agent, "DEPOSIT")`; return `{ ok: true }`.
- `case "WITHDRAW"`: symmetric — same bed-tile gate; require `agent.storageCount(itemId) >= qty` else reject `"your storage has Nx itemId, not qty"`; then `agent.removeFromStorage(itemId, qty)` + `agent.addItem(itemId, qty)`; return `{ ok: true }`.

### 4. `src/agents/Observation.ts`
- `computeAvailableActions`: after the energy block, near the SLEEP/WAIT tail (these are 0-cost like SLEEP, so NOT inside the `energy>0` block):
  - push `"DEPOSIT"` when `onBed && agent.inventory.some((i) => i.qty > 0)`.
  - push `"WITHDRAW"` when `onBed && agent.homeStorage.some((i) => i.qty > 0)`.
- `buildObservation.self`: add `homeStorage: agent.homeStorage.map((i) => ({ ...i }))` (copy, like `inventory`). Surface it always (or only when non-empty — your call, but be consistent and tested).

### 5. `src/llm/parse.ts`
- Add `"DEPOSIT", "WITHDRAW"` to the `ACTION_TYPES` array (so a live LLM emitting them is accepted, not dropped).

### 6. `src/llm/mock.ts`
- Add `"DEPOSIT", "WITHDRAW"` to the `ACTION_TYPES` array (mock normalization).
- In `decide()`, add a DEPOSIT branch **immediately above the SLEEP branch** (stash-before-sleep). It fires when `can("DEPOSIT")` AND the agent holds at least one NON-seed good (an inventory entry whose `itemId` does NOT start with `"seed:"`, qty>0). Emit `DEPOSIT` with `target = { itemId: <that first non-seed good>, qty: <its full qty> }`, a thought like "Stashing the day's harvest at home." Deterministic: pick the FIRST non-seed inventory entry (inventory order) — no RNG. Seeds are never deposited, so once non-seed goods are gone the agent proceeds to SLEEP next turn (terminates; never starves the day-advance).
- Do NOT emit WITHDRAW from the heuristic (document it like the GIVE_GIFT/EMOTE "accepted but never emitted" comments).

### 7. `src/llm/prompts.ts`
- Add a concise mention of DEPOSIT/WITHDRAW to the action list/system prompt so live agents know the verbs exist (one line each; match the existing terse style).

### 8. `src/obs/activityEmoji.ts` (if it's a simple action→emoji map)
- Map `DEPOSIT`/`WITHDRAW` to a sensible glyph (e.g. 📦) for HUD legibility. Only if it doesn't force an unrelated refactor; skip with a note if the file isn't a trivial map.

### 9. Tests (author/extend)
- **New `tests/agents/storage.test.ts`** — the primary gate. Mirror the executor/economy test style (`makeAgent`, `act`, `exec`):
  - Agent helpers: `addToStorage`/`removeFromStorage`/`storageCount` happy + short paths.
  - DEPOSIT: ok on bed (item moves inventory→homeStorage, inventory decremented, storage incremented, energy unchanged); reject off-bed; reject insufficient qty; reject bad target.
  - WITHDRAW: symmetric (storage→inventory); reject off-bed; reject insufficient stored qty.
  - Round-trip: harvest/add a crop → on bed → DEPOSIT → inventory empty + storage holds it → WITHDRAW → back in inventory.
- **Extend `tests/agents/observation.test.ts`** — DEPOSIT offered when on bed + inventory non-empty; WITHDRAW offered when on bed + homeStorage non-empty; NEITHER offered off-bed; `self.homeStorage` surfaced.
- **Extend `tests/llm/mock.test.ts`** — given an observation with the agent on its bed holding a non-seed crop and DEPOSIT in availableActions, mock returns `DEPOSIT` with the right `{itemId, qty}`; same observation twice → identical decision (determinism).

---

## Hard gates (verify must check ALL)

- Full suite green (existing 1079 + new storage cases) and `tsc --noEmit` clean.
- Determinism untouched: map generation unchanged; the mock DEPOSIT decision is a pure function of the observation (no `Math.random`/`Date` anywhere added). `generateMap()` still byte-identical.
- DEPOSIT/WITHDRAW correctly gated on the bed tile; goods conserved (no duplication/loss across deposit+withdraw — qty in == qty out).
- The day-advance is NOT starved: an agent on its bed at night with crops DEPOSITs first, then SLEEPs once goods are stashed (seeds never block it).
- Additive: BUY/SELL/HARVEST/PLANT/SLEEP/USE_OBJECT/VOTE flows are byte-unchanged except the documented pre-sleep stash.
- **No gamed gate.** Do NOT weaken/delete any existing assertion to pass. If the stash-before-sleep behaviour legitimately changes an existing mock/integration expectation (e.g. an agent that used to SLEEP now DEPOSITs first), UPDATE that test to assert the new, correct two-step sequence and explain it in the report — this is a real, documented behaviour change, NOT a weakening. The verify critics will confirm any such edit reflects real behaviour, not gaming. If you cannot tell, set status=blocked and explain.

## File ownership
A SINGLE implement agent owns all of: `contracts/types.ts`, `src/agents/Agent.ts`,
`src/agents/ActionExecutor.ts`, `src/agents/Observation.ts`, `src/llm/parse.ts`,
`src/llm/mock.ts`, `src/llm/prompts.ts`, `src/obs/activityEmoji.ts`, and the three
test files. They are interdependent (types→agent→executor→observation→mock→parse);
one owner, no parallel split.
