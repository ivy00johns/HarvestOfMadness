# Richer World — Town of Homesteads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-everything `24×18` map with a `48×32` town of six homesteads + a shared commons so the six agents live, farm, and sleep in different places and visibly diverge.

**Architecture:** The map stays code-generated in `src/world/map.ts`. A `HOMESTEADS` table drives a generator that stamps six houses (each with its own bed + adjacent soil plot), a commons (shop + tavern + pond), and a road network whose horizontal spine every door opens onto (so connectivity is guaranteed without path stubs). Per-agent start positions + the existing nearest-resolution in both the LLM and mock paths make agents tend their own plots and sleep in their own beds — no ownership rules needed. One bug fix (`mock.ts` picks the *nearest* landmark, not the first) makes divergence hold offline too.

**Tech Stack:** TypeScript, Vitest, Phaser 4 (render only). Run node tools with absolute paths: `/usr/local/bin/node node_modules/.bin/vitest`, `/usr/local/bin/node node_modules/.bin/tsc`.

**Spec:** `docs/superpowers/specs/2026-06-16-richer-world-homesteads-design.md`

**Key constraint:** Several tests stand agents on the exported `BED_POS`, `SHOP_POS`, and `FIELD_RECT`. These exports MUST stay valid and correctly-typed (repointed to Dora's homestead / the commons shop). The generator below does this; the invariant tests in Task 2 guard it.

---

### Task 1: Grow the map + add the `tavern` landmark kind

**Files:**
- Modify: `contracts/types.ts` (`MAP_WIDTH`, `MAP_HEIGHT`, `Landmark.kind`)
- Test: `tests/world/world.test.ts:13-21`

- [ ] **Step 1: Update the failing dimension assertions only**

In `tests/world/world.test.ts`, change the dimension assertions:

```ts
    expect(w.width).toBe(48);
    expect(w.height).toBe(32);
```
and the out-of-bounds checks:
```ts
    expect(w.getTile(48, 0)).toBeNull();
    expect(w.getTile(0, 32)).toBeNull();
```

**Do NOT touch the `SOIL`/`GRASS`/`WATER`/`BUILDING`/`WALL` anchor constants (lines 4-8) yet.** This task only grows the constants; the *old* generator is still active (it just renders on a bigger grid with extra grass), so the old anchors stay valid until Task 2 rewrites the generator. Repointing them now would fail. `(0,0)` is still a wall — leave in-bounds assertions as-is.

- [ ] **Step 2: Run it to verify it fails**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/world.test.ts`
Expected: FAIL — `expected 24 to be 48` (constants still 24/18).

- [ ] **Step 3: Grow the constants and add the landmark kind**

In `contracts/types.ts`, change:
```ts
export const MAP_WIDTH = 48;
export const MAP_HEIGHT = 32;
```
and extend `Landmark`:
```ts
export interface Landmark {
  kind: "shop" | "bed" | "water" | "house" | "tavern";
  pos: Vec2;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/world.test.ts`
Expected: PASS. (The old generator still produces a valid map on the bigger grid — just more grass — so other assertions hold.)

- [ ] **Step 5: Commit**

```bash
git add contracts/types.ts tests/world/world.test.ts
git commit -m "feat: grow the map to 48x32 and add the tavern landmark kind"
```

---

### Task 2: The town generator (homesteads + commons + roads + decor)

**Files:**
- Modify: `src/world/map.ts` (rewrite `generateMap`; add `HOMESTEADS`, `HOMESTEAD_DOORS`, `DecorItem`, `MapData.decor`; repoint back-compat exports)
- Create: `tests/world/map.test.ts`

- [ ] **Step 1: Write the failing invariant + connectivity tests**

Create `tests/world/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";
import {
  BED_POS,
  FIELD_RECT,
  generateMap,
  HOMESTEADS,
  SHOP_POS,
} from "../../src/world/map";

const map = generateMap();
const at = (p: Vec2): TileType => map.tiles[p.y][p.x];

describe("town generator", () => {
  it("is 48x32 with an intact wall ring", () => {
    expect(map.width).toBe(48);
    expect(map.height).toBe(32);
    for (let x = 0; x < MAP_WIDTH; x++) {
      expect(map.tiles[0][x]).toBe("wall");
      expect(map.tiles[MAP_HEIGHT - 1][x]).toBe("wall");
    }
    for (let y = 0; y < MAP_HEIGHT; y++) {
      expect(map.tiles[y][0]).toBe("wall");
      expect(map.tiles[y][MAP_WIDTH - 1]).toBe("wall");
    }
  });

  it("has exactly six homesteads, each a house + bed + door + plot", () => {
    expect(HOMESTEADS).toHaveLength(6);
    for (const h of HOMESTEADS) {
      // 3x3 building footprint (the bed tile inside it is the one exception)
      for (let y = h.house.y; y <= h.house.y + 2; y++) {
        for (let x = h.house.x; x <= h.house.x + 2; x++) {
          const t = map.tiles[y][x];
          expect(t === "building" || t === "bedTile", `house tile ${x},${y}`).toBe(true);
        }
      }
      expect(at(h.bed)).toBe("bedTile");
      expect(at(h.door)).toBe("path");
      for (let y = h.plot.y0; y <= h.plot.y1; y++) {
        for (let x = h.plot.x0; x <= h.plot.x1; x++) {
          expect(at({ x, y }), `plot tile ${x},${y}`).toBe("soil");
        }
      }
    }
  });

  it("has exactly 6 bedTiles and the expected landmark counts", () => {
    let beds = 0;
    for (let y = 0; y < MAP_HEIGHT; y++)
      for (let x = 0; x < MAP_WIDTH; x++) if (map.tiles[y][x] === "bedTile") beds++;
    expect(beds).toBe(6);
    const count = (k: string) => map.landmarks.filter((l) => l.kind === k).length;
    expect(count("bed")).toBe(6);
    expect(count("house")).toBe(6);
    expect(count("shop")).toBe(1);
    expect(count("tavern")).toBe(1);
    expect(count("water")).toBeGreaterThanOrEqual(1);
  });

  it("keeps the back-compat exports valid (tests stand agents on them)", () => {
    expect(at(SHOP_POS)).toBe("shopTile");
    expect(at(BED_POS)).toBe("bedTile");
    expect(at({ x: FIELD_RECT.x0, y: FIELD_RECT.y0 })).toBe("soil");
    expect(at({ x: FIELD_RECT.x0 + 1, y: FIELD_RECT.y0 })).toBe("soil");
  });

  it("connects every homestead door + the shop to the tavern via passable tiles", () => {
    const tavern = map.landmarks.find((l) => l.kind === "tavern")!.pos;
    const impassable = new Set<TileType>(["wall", "water", "building"]);
    const key = (p: Vec2) => `${p.x},${p.y}`;
    const seen = new Set<string>([key(tavern)]);
    const queue: Vec2[] = [tavern];
    while (queue.length) {
      const p = queue.shift()!;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const n = { x: p.x + dx, y: p.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= MAP_WIDTH || n.y >= MAP_HEIGHT) continue;
        if (seen.has(key(n)) || impassable.has(map.tiles[n.y][n.x])) continue;
        seen.add(key(n));
        queue.push(n);
      }
    }
    for (const h of HOMESTEADS) expect(seen.has(key(h.door)), `door ${h.id}`).toBe(true);
    expect(seen.has(key(SHOP_POS)), "shop").toBe(true);
  });

  it("scatters decor only on grass, within bounds, capped", () => {
    expect(map.decor.length).toBeGreaterThan(0);
    expect(map.decor.length).toBeLessThanOrEqual(16);
    for (const d of map.decor) {
      expect(d.kind).toBe("tree");
      expect(d.pos.x).toBeGreaterThan(0);
      expect(d.pos.y).toBeGreaterThan(0);
      expect(d.pos.x).toBeLessThan(MAP_WIDTH - 1);
      expect(d.pos.y).toBeLessThan(MAP_HEIGHT - 1);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/map.test.ts`
Expected: FAIL — `HOMESTEADS` / `map.decor` are not exported yet.

- [ ] **Step 3: Rewrite the generator**

Replace the entire contents of `src/world/map.ts` with:

```ts
/**
 * Code-generated 48x32 town (no Tiled). Six homesteads — each a 3x3 house with
 * its own bed and an adjacent soil plot — ring a central commons (shop, tavern,
 * pond). A horizontal road at y=16 spans the interior; every door opens directly
 * onto it (doors sit at y=15 or y=17), so the whole town is connected with no
 * path stubs. Three vertical roads (x=12/24/36) add cross-town travel.
 *
 * Divergence is spatial: each agent starts at its own door and the LLM/mock both
 * act on the NEAREST crop/tile/bed, so agents tend their own plots and sleep in
 * their own beds without any ownership rules.
 */
import type { Landmark, TileType, Vec2 } from "@contracts/types";
import { MAP_HEIGHT, MAP_WIDTH } from "@contracts/types";

export interface DecorItem {
  kind: "tree";
  pos: Vec2;
}

export interface MapData {
  width: number;
  height: number;
  /** tiles[y][x] */
  tiles: TileType[][];
  landmarks: Landmark[];
  /** non-interactive scenery (renderer only) */
  decor?: DecorItem[];
}

/** Inclusive rect fill helper. */
function fillRect(
  tiles: TileType[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  type: TileType,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles[y][x] = type;
    }
  }
}

interface HomesteadSpec {
  /** persona id (matches src/agents/personas.ts) */
  id: string;
  /** top-left tile of the 3x3 house building */
  house: Vec2;
  /** bedTile (inside the house footprint) */
  bed: Vec2;
  /** path tile in front of the bed — the persona's start (at y=15 or y=17) */
  door: Vec2;
  /** personal soil plot (inclusive rect) */
  plot: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Six homesteads spread to the quadrants + the center commons. Doors sit one
 * tile off the y=16 road. Persona placement matches flavor (Sage by the tavern,
 * Moss by the pond, the rest in the corners).
 */
export const HOMESTEADS: HomesteadSpec[] = [
  { id: "dora",  house: { x: 5,  y: 12 }, bed: { x: 6,  y: 14 }, door: { x: 6,  y: 15 }, plot: { x0: 8,  y0: 12, x1: 11, y1: 14 } },
  { id: "gus",   house: { x: 39, y: 12 }, bed: { x: 40, y: 14 }, door: { x: 40, y: 15 }, plot: { x0: 32, y0: 12, x1: 35, y1: 14 } },
  { id: "fern",  house: { x: 5,  y: 18 }, bed: { x: 6,  y: 18 }, door: { x: 6,  y: 17 }, plot: { x0: 8,  y0: 18, x1: 11, y1: 20 } },
  { id: "rusty", house: { x: 39, y: 18 }, bed: { x: 40, y: 18 }, door: { x: 40, y: 17 }, plot: { x0: 32, y0: 18, x1: 35, y1: 20 } },
  { id: "sage",  house: { x: 26, y: 12 }, bed: { x: 27, y: 14 }, door: { x: 27, y: 15 }, plot: { x0: 26, y0: 8,  x1: 29, y1: 10 } },
  { id: "moss",  house: { x: 28, y: 18 }, bed: { x: 29, y: 18 }, door: { x: 29, y: 17 }, plot: { x0: 31, y0: 22, x1: 34, y1: 24 } },
];

/** persona id → start (door) tile, consumed by src/agents/personas.ts. */
export const HOMESTEAD_DOORS: Record<string, Vec2> = Object.fromEntries(
  HOMESTEADS.map((h) => [h.id, { ...h.door }]),
);

// -- commons (center) --------------------------------------------------------
const SHOP_BUILDING: Vec2 = { x: 16, y: 12 };
const SHOP_TILE: Vec2 = { x: 17, y: 14 }; // bottom-center of the shop building
const SHOP_DOOR: Vec2 = { x: 17, y: 15 };
const TAVERN_BUILDING: Vec2 = { x: 21, y: 12 };
const TAVERN_DOOR: Vec2 = { x: 22, y: 15 };
const POND = { x0: 30, y0: 9, x1: 33, y1: 12 };

// -- back-compat representative exports (existing importers depend on these) --
export const SHOP_POS: Vec2 = { ...SHOP_TILE };
export const BED_POS: Vec2 = { ...HOMESTEADS[0].bed }; // Dora's bed
export const HOUSE_POS: Vec2 = { ...HOMESTEADS[0].door }; // Dora's door
export const WATER_POS: Vec2 = { x: POND.x0, y: POND.y0 }; // a pond edge
export const FIELD_RECT = { ...HOMESTEADS[0].plot }; // Dora's plot

function stampHomestead(tiles: TileType[][], landmarks: Landmark[], h: HomesteadSpec): void {
  fillRect(tiles, h.house.x, h.house.y, h.house.x + 2, h.house.y + 2, "building");
  tiles[h.bed.y][h.bed.x] = "bedTile";
  tiles[h.door.y][h.door.x] = "path";
  fillRect(tiles, h.plot.x0, h.plot.y0, h.plot.x1, h.plot.y1, "soil");
  landmarks.push({ kind: "bed", pos: { ...h.bed } });
  landmarks.push({ kind: "house", pos: { ...h.door } });
}

export function generateMap(): MapData {
  const tiles: TileType[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    tiles.push(new Array<TileType>(MAP_WIDTH).fill("grass"));
  }

  // Wall border.
  fillRect(tiles, 0, 0, MAP_WIDTH - 1, 0, "wall");
  fillRect(tiles, 0, MAP_HEIGHT - 1, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, 0, 0, 0, MAP_HEIGHT - 1, "wall");
  fillRect(tiles, MAP_WIDTH - 1, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1, "wall");

  // Road network: the y=16 spine every door opens onto, plus three verticals.
  // Laid before structures — they occupy disjoint tiles by construction.
  fillRect(tiles, 1, 16, MAP_WIDTH - 2, 16, "path");
  for (const rx of [12, 24, 36]) fillRect(tiles, rx, 1, rx, MAP_HEIGHT - 2, "path");

  const landmarks: Landmark[] = [];

  for (const h of HOMESTEADS) stampHomestead(tiles, landmarks, h);

  // Shop (trade).
  fillRect(tiles, SHOP_BUILDING.x, SHOP_BUILDING.y, SHOP_BUILDING.x + 2, SHOP_BUILDING.y + 2, "building");
  tiles[SHOP_TILE.y][SHOP_TILE.x] = "shopTile";
  tiles[SHOP_DOOR.y][SHOP_DOOR.x] = "path";
  landmarks.push({ kind: "shop", pos: { ...SHOP_TILE } });

  // Tavern (social hub — a building footprint with a door; no special tile).
  fillRect(tiles, TAVERN_BUILDING.x, TAVERN_BUILDING.y, TAVERN_BUILDING.x + 2, TAVERN_BUILDING.y + 2, "building");
  tiles[TAVERN_DOOR.y][TAVERN_DOOR.x] = "path";
  landmarks.push({ kind: "tavern", pos: { ...TAVERN_DOOR } });

  // Pond (scenery; Moss's spot).
  fillRect(tiles, POND.x0, POND.y0, POND.x1, POND.y1, "water");
  landmarks.push({ kind: "water", pos: { ...WATER_POS } });

  // Decorative trees on open grass (all-grass 4-neighbourhood), deterministic
  // (no RNG) and capped so the bigger map reads alive without clutter.
  const decor: DecorItem[] = [];
  for (let y = 2; y < MAP_HEIGHT - 2 && decor.length < 16; y++) {
    for (let x = 2; x < MAP_WIDTH - 2; x++) {
      if (tiles[y][x] !== "grass") continue;
      const allGrass =
        tiles[y - 1][x] === "grass" &&
        tiles[y + 1][x] === "grass" &&
        tiles[y][x - 1] === "grass" &&
        tiles[y][x + 1] === "grass";
      if (allGrass && (x * 7 + y * 13) % 17 === 0) decor.push({ kind: "tree", pos: { x, y } });
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, landmarks, decor };
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/map.test.ts`
Expected: PASS. If the connectivity or back-compat test fails, a coordinate in `HOMESTEADS`/commons collides with a road, wall, or another footprint — nudge that coordinate (keep doors at y=15/17) and re-run. The tests are the source of truth.

- [ ] **Step 5: Repoint the `world.test.ts` anchors to the new map**

The new generator invalidates the old-map anchors in `tests/world/world.test.ts`. Replace the five anchor constants (lines 4-8) with new-map tiles:

```ts
const SOIL = { x: 9, y: 13 }; // inside Dora's homestead plot
const GRASS = { x: 3, y: 8 }; // open grass
const WATER = { x: 31, y: 10 }; // the pond
const BUILDING = { x: 5, y: 12 }; // Dora's house
const WALL = { x: 0, y: 0 };
```

And update the three inline tile-type probes in the `isPassable` test (currently lines 42, 44, 45) so the comments match real tiles:

```ts
    expect(w.isPassable(6, 16)).toBe(true); // path (the town road)
```
```ts
    expect(w.isPassable(6, 14)).toBe(true); // bedTile (Dora's bed)
    expect(w.isPassable(17, 14)).toBe(true); // shopTile (the commons shop)
```

The `landmarks` test (lines 63-73) needs no change: `Object.fromEntries` dedups the now-six bed/house landmarks to the last one, which is still a valid `bedTile`/door with a path to the shop.

- [ ] **Step 6: Run the full suite to catch downstream breakage**

Run: `/usr/local/bin/node node_modules/.bin/vitest run`
Expected: PASS. The `executor`, `observation`, `economy-invariants`, and `executor-matrix` suites stand agents on `BED_POS`/`SHOP_POS`/`FIELD_RECT` — they pass because those exports point at correctly-typed tiles (Step 3). If any other suite asserts a raw old-map coordinate, repoint it to the equivalent new-map tile.

- [ ] **Step 7: Typecheck and commit**

```bash
/usr/local/bin/node node_modules/.bin/tsc --noEmit
git add src/world/map.ts tests/world/map.test.ts tests/world/world.test.ts
git commit -m "feat: generate a six-homestead town with a shared commons"
```

---

### Task 3: Expose decor from the World

**Files:**
- Modify: `src/world/World.ts` (import `DecorItem`, store `map.decor`, add `decor()`)
- Test: `tests/world/world.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/world/world.test.ts`, inside the `describe("World map + queries", …)` block (the file already imports `World` from `../../src/world/World` and constructs `new World()` in every test):

```ts
  it("exposes the map's decor list (defensive copy, defaults empty)", () => {
    const w = new World();
    const decor = w.decor();
    expect(Array.isArray(decor)).toBe(true);
    expect(decor.length).toBeGreaterThan(0);
    // mutating the returned copy must not affect the world
    decor.length = 0;
    expect(w.decor().length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/world.test.ts`
Expected: FAIL — `w.decor is not a function`.

- [ ] **Step 3: Add the field + method**

In `src/world/World.ts`, extend the map import:
```ts
import { generateMap, type DecorItem, type MapData } from "./map";
```
Add a private field beside `mapLandmarks`:
```ts
  private readonly mapDecor: DecorItem[];
```
In the constructor, after `this.mapLandmarks = map.landmarks;`:
```ts
    this.mapDecor = map.decor ?? [];
```
Add a method beside `landmarks()`:
```ts
  /** Non-interactive scenery for the renderer (defensive copy). */
  decor(): DecorItem[] {
    return this.mapDecor.map((d) => ({ kind: d.kind, pos: { ...d.pos } }));
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/world/world.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/world/World.ts tests/world/world.test.ts
git commit -m "feat: expose map decor from the World"
```

---

### Task 4: Wire personas to their homesteads

**Files:**
- Modify: `src/agents/personas.ts` (import `HOMESTEAD_DOORS`, set each `start`, append a home hint)
- Create: `tests/agents/personas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/personas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PERSONAS } from "../../src/agents/personas";
import { generateMap, HOMESTEAD_DOORS, HOMESTEADS } from "../../src/world/map";

const map = generateMap();

describe("personas live at their homesteads", () => {
  it("each persona starts on its homestead door (a path tile)", () => {
    for (const p of PERSONAS) {
      const door = HOMESTEAD_DOORS[p.id];
      expect(door, `homestead for ${p.id}`).toBeDefined();
      expect(p.start).toEqual(door);
      expect(map.tiles[p.start.y][p.start.x]).toBe("path");
    }
  });

  it("every persona has a distinct start", () => {
    const keys = PERSONAS.map((p) => `${p.start.x},${p.start.y}`);
    expect(new Set(keys).size).toBe(PERSONAS.length);
  });

  it("the nearest bed to each start is that homestead's own bed", () => {
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const beds = map.landmarks.filter((l) => l.kind === "bed").map((l) => l.pos);
    for (const h of HOMESTEADS) {
      const nearest = [...beds].sort((a, b) => cheb(h.door, a) - cheb(h.door, b))[0];
      expect(nearest, `nearest bed for ${h.id}`).toEqual(h.bed);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/agents/personas.test.ts`
Expected: FAIL — starts still point at the old farmhouse cluster `(3,5)` etc.

- [ ] **Step 3: Repoint starts + add home hints**

In `src/agents/personas.ts`, add at the top (after the existing import):
```ts
import { HOMESTEAD_DOORS } from "../world/map";
```
For each persona, replace its `start: { x: …, y: … }` line with the homestead door, and append a home-hint sentence to its `description`. Exact changes per persona:

- Dora: `start: { ...HOMESTEAD_DOORS.dora },` — append to description: `" Your homestead is the northwest cottage; your plot adjoins it."`
- Rusty: `start: { ...HOMESTEAD_DOORS.rusty },` — append: `" Your place is the southeast cottage, a long walk from the shop."`
- Sage: `start: { ...HOMESTEAD_DOORS.sage },` — append: `" Your cottage sits beside the tavern, where everyone passes."`
- Gus: `start: { ...HOMESTEAD_DOORS.gus },` — append: `" Your homestead is the northeast cottage; your plot adjoins it."`
- Fern: `start: { ...HOMESTEAD_DOORS.fern },` — append: `" Your homestead is the southwest cottage; you walk the long way to town."`
- Moss: `start: { ...HOMESTEAD_DOORS.moss },` — append: `" Your cottage overlooks the pond; your plot is just south of it."`

Keep each persona's existing mock-flavor keywords ("reckless", "social", …) intact — only append to the description string.

- [ ] **Step 4: Run it to verify it passes**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/agents/personas.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite (start positions feed the scheduler)**

Run: `/usr/local/bin/node node_modules/.bin/vitest run`
Expected: PASS. If a scheduler/bootstrap test asserted an old start coordinate, update it to read from `HOMESTEAD_DOORS`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/personas.ts tests/agents/personas.test.ts
git commit -m "feat: start each persona at its own homestead"
```

---

### Task 5: Mock heuristic picks the nearest landmark, not the first

**Files:**
- Modify: `src/llm/mock.ts:208-218` (`findLandmark`)
- Test: `tests/llm/mock.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/llm/mock.test.ts` (it already has `makeObs`, `decideFor`, and imports `parseAgentAction`):

```ts
  it("targets the NEAREST bed when several exist (homestead divergence)", async () => {
    const near = { x: 6, y: 6 };
    const far = { x: 40, y: 20 };
    const obs = makeObs({
      self: {
        pos: { x: 5, y: 6 },
        energy: 40,
        inventory: [{ itemId: "seed:parsnip", qty: 5 }], // skip the buy-seeds branch
      },
      time: { day: 1, phase: "night" },
      nearby: {
        tiles: [],
        agents: [],
        landmarks: [
          { kind: "bed", pos: far }, // listed FIRST → the old .find() picked this
          { kind: "bed", pos: near },
          { kind: "shop", pos: { x: 17, y: 14 } },
        ],
      },
    });
    const res = await decideFor(obs);
    const action = parseAgentAction(res.raw);
    expect(action.action).toBe("MOVE_TO");
    expect(action.target).toEqual(near);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/llm/mock.test.ts`
Expected: FAIL — `expected { x: 40, y: 20 } to equal { x: 6, y: 6 }` (the first bed is chosen).

- [ ] **Step 3: Fix `findLandmark` to pick the nearest match**

In `src/llm/mock.ts`, replace the body of `findLandmark` (lines 208-218):

```ts
function findLandmark(obs: Observation, kind: "shop" | "bed"): Vec2 | null {
  const lm = nearest(
    obs.self.pos,
    obs.nearby.landmarks.filter((l) => l.kind === kind).map((l) => l.pos),
  );
  if (lm) return { x: lm.x, y: lm.y };
  // Fall back to the nearest visible bedTile/shopTile when no landmark is given.
  const tileType = kind === "shop" ? "shopTile" : "bedTile";
  const tile = nearest(
    obs.self.pos,
    obs.nearby.tiles.filter((t) => t.type === tileType),
  );
  return tile ? { x: tile.x, y: tile.y } : null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `/usr/local/bin/node node_modules/.bin/vitest run tests/llm/mock.test.ts`
Expected: PASS — and the existing 30 mock tests still pass (single-bed cases pick that bed either way).

- [ ] **Step 5: Commit**

```bash
git add src/llm/mock.ts tests/llm/mock.test.ts
git commit -m "fix: mock heuristic heads to the nearest bed/shop, not the first"
```

---

### Task 6: Render decor data-driven from the World

**Files:**
- Modify: `src/scenes/WorldScene.ts` (`dressTrees`; remove the hardcoded `TREE_SPOTS`)

There is no headless Phaser test; this task is verified by typecheck/build + a browser check.

- [ ] **Step 1: Replace `dressTrees` to read `World.decor()`**

In `src/scenes/WorldScene.ts`, replace the `dressTrees` method (currently lines 664-677) with:

```ts
  private dressTrees(): void {
    if (!this.textures.exists("fruit_trees")) return;
    for (const d of getWorld().decor()) {
      const frame = TREE_FRAMES[(d.pos.x + d.pos.y) % TREE_FRAMES.length];
      this.add
        .image(
          d.pos.x * TILE_SIZE + TILE_SIZE / 2,
          (d.pos.y + 1) * TILE_SIZE - 2,
          "fruit_trees",
          frame,
        )
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_OVERHEAD);
    }
  }
```

- [ ] **Step 2: Remove the now-unused `TREE_SPOTS` constant**

Delete the `TREE_SPOTS` declaration (currently lines 95-99) and its leading doc comment (lines 90-94). Keep `TREE_FRAMES`.

- [ ] **Step 3: Typecheck and build**

Run: `/usr/local/bin/node node_modules/.bin/tsc --noEmit && /usr/local/bin/node node_modules/.bin/vite build`
Expected: clean typecheck; build succeeds (the pre-existing ~1.7MB Phaser chunk-size warning is unrelated and OK).

- [ ] **Step 4: Browser smoke check**

Start the dev server (`/usr/local/bin/npm run dev`), open http://localhost:5175, and confirm: the map is the larger town, six houses with beds are visible, agents spawn spread across the six homesteads (not clustered), and decorative trees appear on grass. Use the Playwright browser verifier (screenshot, not DOM snapshot — it's a canvas) per the project's browser-verification note.

- [ ] **Step 5: Commit**

```bash
git add src/scenes/WorldScene.ts
git commit -m "feat: render decorative trees from the map's decor list"
```

---

## Out of scope (explicit follow-ups)

- **Per-homestead house facades.** `WorldScene` draws a fancy facade only at `BED_POS`/`SHOP_POS` (lines ~600-615); the other five houses render as plain building tiles. Generalizing the facade loop over `HOMESTEADS` is a visual polish chunk, not behavioral.
- **New action verbs** (forage/fish/chop) and **contract-deep `home`/`plotRect` ownership** — the spec's named fast-follows.

## Final verification (after all tasks)

- [ ] `/usr/local/bin/node node_modules/.bin/vitest run` — all suites green.
- [ ] `/usr/local/bin/node node_modules/.bin/tsc --noEmit` — clean.
- [ ] `/usr/local/bin/node node_modules/.bin/vite build` — succeeds.
- [ ] Browser: six homesteads, spread agents, trees, and (with `VITE_MODEL_MODE=live`) agents tending their own plots / sleeping in their own beds.
