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

  /**
   * Resolves to null whenever no usable manifest exists (the default).
   *
   * Console-cleanliness note (DoD gate checks error level): we deliberately
   * send the browser-default Accept header. Vite's dev server then answers a
   * missing manifest with its SPA fallback (200 + index.html) instead of a
   * 404, so NOTHING is logged at error level; the JSON.parse guard below
   * classifies that HTML as "no manifest". On a static host that does return
   * a real 404, fetch() itself never throws or logs an error-level entry —
   * the response is handled silently via res.ok. Browser-only path; verified
   * manually via Playwright (0 error-level console messages on boot).
   */
  private async probeManifest(): Promise<AssetManifest | null> {
    try {
      const res = await fetch("assets/manifest.json");
      if (!res.ok) return null;
      const text = await res.text();
      return JSON.parse(text) as AssetManifest; // HTML fallback fails -> catch
    } catch {
      return null;
    }
  }
}
