/**
 * BootScene — loads the LPC art listed in public/assets/manifest.json
 * (AssetManifest contract type) with a guaranteed zero-asset path.
 *
 * Contract rule 15: on a missing manifest, a parse error, or any file that
 * fails to load we log ONE warning, flag "no assets" in the registry and
 * proceed — WorldScene then renders the v1 placeholder graphics (colored
 * rects + labeled circles). No code path hard-requires an image file.
 *
 * A plain fetch probe is used instead of Phaser's JSON loader because dev
 * servers with SPA fallback return index.html for missing files, which would
 * make the loader log a parse error on the zero-asset path.
 */
import Phaser from "phaser";
import type { AssetManifest } from "@contracts/types";
import { REG_ASSETS_ON, REG_ASSET_MANIFEST } from "../config";

/** Texture key prefix for crop growth strips ("crop_potato", ...). */
export const CROP_TEXTURE_PREFIX = "crop_";

/**
 * fruit-trees.png is the one sheet we slice on a non-32px grid: each complete
 * tree (canopy + trunk + shadow) occupies a 96x128 cell.
 */
const FRUIT_TREE_FRAME = { width: 96, height: 128 } as const;

function isAssetManifest(v: unknown): v is AssetManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m.version === 1 &&
    Array.isArray(m.characters) &&
    Array.isArray(m.crops) &&
    Array.isArray(m.tilesets)
  );
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    const manifest = await this.probeManifest();
    if (!manifest) {
      // Rule 15: exactly ONE warning, then the placeholder path.
      console.warn(
        "[boot] assets/manifest.json missing or invalid — using v1 placeholder graphics",
      );
      this.startWorld(false, null);
      return;
    }

    let failedFile: string | null = null;
    this.load.on(
      Phaser.Loader.Events.FILE_LOAD_ERROR,
      (file: { key?: string }) => {
        if (failedFile === null) failedFile = file?.key ?? "unknown";
      },
    );

    for (const c of manifest.characters) {
      this.load.spritesheet(c.key, c.path, {
        frameWidth: c.frameWidth,
        frameHeight: c.frameHeight,
      });
    }
    for (const crop of manifest.crops) {
      this.load.spritesheet(`${CROP_TEXTURE_PREFIX}${crop.kind}`, crop.path, {
        frameWidth: crop.frameWidth,
        frameHeight: crop.frameHeight,
      });
    }
    for (const t of manifest.tilesets) {
      if (t.key === "fruit_trees") {
        this.load.spritesheet(t.key, t.path, {
          frameWidth: FRUIT_TREE_FRAME.width,
          frameHeight: FRUIT_TREE_FRAME.height,
        });
      } else {
        this.load.spritesheet(t.key, t.path, {
          frameWidth: t.tileWidth,
          frameHeight: t.tileHeight,
        });
      }
    }

    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      if (failedFile !== null) {
        // Rule 15: a broken asset set degrades to placeholders, ONE warning.
        console.warn(
          `[boot] asset "${failedFile}" failed to load — using v1 placeholder graphics`,
        );
        this.startWorld(false, null);
      } else {
        this.crispenTextures(manifest);
        this.startWorld(true, manifest);
      }
    });
    this.load.start();
  }

  /**
   * Keep the loaded pixel-art crisp now that the game no longer runs in global
   * `pixelArt` mode (which we dropped so HUD TEXT renders smooth, not jagged —
   * see src/main.ts). Antialiasing is fine for text but would bilinear-blur the
   * tile/sprite art, so every loaded sheet gets a NEAREST filter: crisp tiles,
   * smooth text. Vector placeholders (no-asset mode) need nothing.
   */
  private crispenTextures(manifest: AssetManifest): void {
    const keys = [
      ...manifest.characters.map((c) => c.key),
      ...manifest.crops.map((c) => `${CROP_TEXTURE_PREFIX}${c.kind}`),
      ...manifest.tilesets.map((t) => t.key),
    ];
    for (const key of keys) {
      if (this.textures.exists(key)) {
        this.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
    }
  }

  private startWorld(assetsOn: boolean, manifest: AssetManifest | null): void {
    this.registry.set(REG_ASSETS_ON, assetsOn);
    this.registry.set(REG_ASSET_MANIFEST, manifest);
    this.scene.start("world");
  }

  /**
   * Resolves to null whenever no usable manifest exists.
   *
   * Console-cleanliness note (DoD gate checks error level): we deliberately
   * send the browser-default Accept header. Vite's dev server then answers a
   * missing manifest with its SPA fallback (200 + index.html) instead of a
   * 404, so NOTHING is logged at error level; the JSON.parse + shape guard
   * below classifies that HTML as "no manifest". On a static host that does
   * return a real 404, fetch() itself never throws or logs an error-level
   * entry — the response is handled silently via res.ok.
   */
  private async probeManifest(): Promise<AssetManifest | null> {
    try {
      const res = await fetch("assets/manifest.json");
      if (!res.ok) return null;
      const text = await res.text();
      const parsed: unknown = JSON.parse(text); // HTML fallback fails -> catch
      return isAssetManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
