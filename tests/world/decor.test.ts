import { describe, expect, it } from "vitest";
import { DECOR_FRAMES, decorSprite } from "../../src/world/render";

describe("decorSprite (pure decor frame mapping)", () => {
  it("maps each kind to its sheet + a frame from its list", () => {
    for (const kind of ["tree", "bush", "flower", "grass"] as const) {
      const spec = DECOR_FRAMES[kind];
      const s = decorSprite(kind, 0);
      expect(s.texture).toBe(spec.texture);
      expect(spec.frames).toContain(s.frame);
      expect(s.layer).toBe(spec.layer);
    }
  });

  it("wraps variant indices (including negatives) into the frame list", () => {
    for (const kind of ["tree", "bush", "flower", "grass"] as const) {
      const n = DECOR_FRAMES[kind].frames.length;
      expect(decorSprite(kind, n).frame).toBe(decorSprite(kind, 0).frame);
      expect(decorSprite(kind, -1).frame).toBe(DECOR_FRAMES[kind].frames[n - 1]);
    }
  });

  it("assigns sensible render layers (trees overhead, tufts on the ground)", () => {
    expect(decorSprite("tree", 0).layer).toBe("overhead");
    expect(decorSprite("bush", 0).layer).toBe("ysort");
    expect(decorSprite("flower", 0).layer).toBe("ground");
    expect(decorSprite("grass", 0).layer).toBe("ground");
  });
});
