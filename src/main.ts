/**
 * STUB — world-agent (W1) replaces this file with the real bootstrap
 * (src/main.ts + src/config.ts + src/scenes/*). It exists only so
 * `npm run dev` renders something on day zero.
 */
import Phaser from "phaser";

class PendingScene extends Phaser.Scene {
  constructor() {
    super("pending");
  }

  create(): void {
    this.add
      .text(
        this.scale.width / 2,
        this.scale.height / 2,
        "Harvest of Madness — world engine pending",
        {
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: "20px",
          color: "#9be89b",
        },
      )
      .setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 768,
  height: 576,
  backgroundColor: "#101014",
  scene: [PendingScene],
});
