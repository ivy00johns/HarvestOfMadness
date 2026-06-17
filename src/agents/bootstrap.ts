/**
 * Agent pipeline bootstrap. Call startAgents() from any init hook (main.ts
 * carve-out is owned by obs-agent); it self-defers until the WorldScene has
 * published its RenderApi, then registers sprites and starts the scheduler.
 * Idempotent and headless-safe (never throws when Phaser never boots).
 */
import { getRenderApi } from "../world/render";
import { getAgentManager } from "./AgentManager";
import { PERSONAS } from "./personas";

const READY_POLL_MS = 250;

let started = false;

export function startAgents(): void {
  if (started) return;
  started = true;
  const tryStart = (): void => {
    if (getRenderApi() !== null) {
      getAgentManager().start(PERSONAS);
      return;
    }
    setTimeout(tryStart, READY_POLL_MS);
  };
  tryStart();
}
