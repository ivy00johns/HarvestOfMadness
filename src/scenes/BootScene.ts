/**
 * BootScene — optional asset loading with a guaranteed zero-asset path.
 *
 * If public/assets/manifest.json exists and lists images
 * ({ "images": { "key": "relative/path.png" } }) they are loaded; when the
 * manifest is absent (the default), we proceed straight to WorldScene, which
 * renders everything with Graphics placeholders.
 *
 * A plain fetch probe is used instead of Phaser's JSON loader because dev
 * servers with SPA fallback return index.html for missing files, which would
 * make the loader log a parse error on the zero-asset path.
 */
import Phaser from "phaser";

interface AssetManifest {
  images?: Record<string, string>;
}

export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create(): void {
    void this.probeManifest().then((manifest) => {
      const images = manifest?.images;
      if (images && Object.keys(images).length > 0) {
        for (const [key, path] of Object.entries(images)) {
          this.load.image(key, `assets/${path}`);
        }
        this.load.once(Phaser.Loader.Events.COMPLETE, () => {
          this.scene.start("world");
        });
        this.load.start();
      } else {
        this.scene.start("world");
      }
    });
  }

  /** Resolves to null whenever no usable manifest exists (the default). */
  private async probeManifest(): Promise<AssetManifest | null> {
    try {
      const res = await fetch("assets/manifest.json", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trimStart().startsWith("<")) return null; // SPA fallback HTML
      return JSON.parse(text) as AssetManifest;
    } catch {
      return null;
    }
  }
}
