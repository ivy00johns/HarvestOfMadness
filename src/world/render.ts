/**
 * RenderApi access point. WorldScene calls setRenderApi(this) in create();
 * agent-pipeline code imports getRenderApi() — no circular imports, and a
 * null return simply means the scene is not booted yet (callers may no-op).
 */
import type { RenderApi } from "@contracts/types";

let current: RenderApi | null = null;

export function setRenderApi(api: RenderApi | null): void {
  current = api;
}

export function getRenderApi(): RenderApi | null {
  return current;
}
