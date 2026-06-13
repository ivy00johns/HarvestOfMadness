/**
 * QE v2 — asset pipeline supply side (rules 15/16), headless.
 *
 * BootScene's runtime fallback (fetch 404/parse error → ONE warning →
 * placeholders) needs a browser and is delegated to the browser verifier;
 * what IS testable headless is everything the fallback depends on:
 *
 *  - public/assets/manifest.json conforms to the AssetManifest contract
 *    (version 1, tileSize 32, LPC 64×64 walk sheets with 9 frames/row);
 *  - every path the manifest references actually exists under public/
 *    (a manifest pointing at a missing file would silently force the
 *    placeholder path in "assets present" mode);
 *  - every contract CropKind is renderable: a direct strip OR the
 *    WorldScene alias (cauliflower → turnip) — otherwise a crop kind would
 *    ship invisible;
 *  - rule 16: every shipped binary asset is enumerated in CREDITS.txt, and
 *    no forbidden (non-redistributable) pack names appear anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssetManifest } from "@contracts/types";
import { CROPS, TILE_SIZE } from "@contracts/types";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const MANIFEST_PATH = path.join(PUBLIC_DIR, "assets", "manifest.json");

/** WorldScene's documented strip alias (src/scenes/WorldScene.ts). */
const CROP_STRIP_ALIAS: Record<string, string> = { cauliflower: "turnip" };

const TILESET_PURPOSES = ["terrain", "water", "farming", "buildings", "trees"];

function loadManifest(): AssetManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as AssetManifest;
}

function listAssetFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(path.join(PUBLIC_DIR, "assets"));
  return out;
}

describe("AssetManifest contract conformance (public/assets/manifest.json)", () => {
  const manifest = loadManifest();

  it("top-level shape: version 1, tileSize 32, all four sections present", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.tileSize).toBe(TILE_SIZE);
    expect(Array.isArray(manifest.characters)).toBe(true);
    expect(Array.isArray(manifest.crops)).toBe(true);
    expect(Array.isArray(manifest.tilesets)).toBe(true);
    expect(manifest.characters.length).toBeGreaterThanOrEqual(1);
    expect(manifest.water).toBeDefined();
  });

  it("characters are LPC walk sheets: 64×64 frames, 9 frames/row, 4 directional rows, unique keys", () => {
    const keys = new Set<string>();
    for (const c of manifest.characters) {
      expect(typeof c.name, c.key).toBe("string");
      expect(c.frameWidth, c.key).toBe(64);
      expect(c.frameHeight, c.key).toBe(64);
      expect(c.framesPerRow, c.key).toBe(9);
      for (const row of ["walkUp", "walkLeft", "walkDown", "walkRight"] as const) {
        expect(Number.isInteger(c.rows[row]), `${c.key}.rows.${row}`).toBe(true);
        expect(c.rows[row], `${c.key}.rows.${row}`).toBeGreaterThanOrEqual(0);
      }
      expect(keys.has(c.key), `duplicate key ${c.key}`).toBe(false);
      keys.add(c.key);
    }
  });

  it("crops have 5 stage frames (seed→ready) and unique kinds", () => {
    const kinds = new Set<string>();
    for (const c of manifest.crops) {
      expect(c.stageFrames, c.kind).toHaveLength(5);
      for (const f of c.stageFrames) expect(Number.isInteger(f), c.kind).toBe(true);
      expect(kinds.has(c.kind), `duplicate crop ${c.kind}`).toBe(false);
      kinds.add(c.kind);
    }
  });

  it("every contract CropKind is renderable via a strip or the documented alias", () => {
    const stripKinds = new Set(manifest.crops.map((c) => c.kind));
    for (const kind of Object.keys(CROPS)) {
      const resolved = stripKinds.has(kind) ? kind : CROP_STRIP_ALIAS[kind];
      expect(
        resolved !== undefined && stripKinds.has(resolved),
        `CropKind "${kind}" has no strip and no alias — it would render invisible in assets mode`,
      ).toBe(true);
    }
  });

  it("tilesets carry contract purposes and unique keys; water entry is sane", () => {
    const keys = new Set<string>();
    for (const t of manifest.tilesets) {
      expect(TILESET_PURPOSES, t.key).toContain(t.purpose);
      expect(t.tileWidth, t.key).toBeGreaterThan(0);
      expect(t.tileHeight, t.key).toBeGreaterThan(0);
      expect(keys.has(t.key), `duplicate tileset key ${t.key}`).toBe(false);
      keys.add(t.key);
    }
    expect(manifest.water.animFrames).toBeGreaterThanOrEqual(1);
    expect(typeof manifest.water.key).toBe("string");
  });

  it("EVERY path referenced by the manifest exists under public/ (no silent placeholder downgrade)", () => {
    const paths = [
      ...manifest.characters.map((c) => c.path),
      ...manifest.crops.map((c) => c.path),
      ...manifest.tilesets.map((t) => t.path),
      manifest.water.path,
    ];
    for (const p of paths) {
      expect(p.startsWith("assets/"), `${p} is public-relative`).toBe(true);
      expect(p.includes(".."), `${p} stays inside public/`).toBe(false);
      expect(fs.existsSync(path.join(PUBLIC_DIR, p)), `missing file: ${p}`).toBe(true);
    }
  });
});

describe("rule 16 — license hygiene", () => {
  it("every shipped binary asset is enumerated in CREDITS.txt", () => {
    const credits = fs.readFileSync(path.join(ROOT, "CREDITS.txt"), "utf8");
    const binaries = listAssetFiles().filter((f) => /\.(png|jpg|jpeg|gif|webp|ogg|wav|mp3)$/i.test(f));
    expect(binaries.length).toBeGreaterThan(0);
    for (const f of binaries) {
      expect(
        credits.includes(path.basename(f)),
        `${path.relative(PUBLIC_DIR, f)} is not attributed in CREDITS.txt`,
      ).toBe(true);
    }
  });

  it("no forbidden / non-redistributable pack names anywhere under public/assets", () => {
    for (const f of listAssetFiles()) {
      expect(f.toLowerCase(), f).not.toMatch(/sprout[ _-]?lands?|cute[ _-]?fantasy/);
    }
  });
});
