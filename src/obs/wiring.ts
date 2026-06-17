/**
 * wiring — connection from the HUD to the agent pipeline (agents-agent W2).
 *
 * Domain rule: the UI drives pause/step/speed THROUGH AgentManager (which
 * forwards to the TimeSystem and also gates decision scheduling), never the
 * TimeSystem directly. SimControls is the narrow structural surface the HUD
 * needs; AgentManager satisfies it as-is, and tests can stub it cheaply.
 */
import type { EventBus } from "@contracts/types";
import { getAgentManager } from "../agents/AgentManager";
import { getEventBus } from "../agents/events";
import type { Speed } from "../world/TimeSystem";
import type { InspectableAgent } from "./Inspector";

/** Control surface the HUD needs (subset of AgentManager's public API). */
export interface SimControls {
  pause(): void;
  resume(): void;
  /** one full decision cycle for the longest-idle agent (works while paused) */
  step(): void;
  setSpeed(multiplier: Speed): void;
  isPaused(): boolean;
  agents(): InspectableAgent[];
}

export interface ObsConnection {
  bus: EventBus;
  controls: SimControls;
}

export function connectObservability(): ObsConnection {
  return { bus: getEventBus(), controls: getAgentManager() };
}
