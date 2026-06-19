/**
 * wiring — connection from the HUD to the agent pipeline (agents-agent W2).
 *
 * Domain rule: the UI drives pause/step/speed THROUGH AgentManager (which
 * forwards to the TimeSystem and also gates decision scheduling), never the
 * TimeSystem directly. SimControls is the narrow structural surface the HUD
 * needs; AgentManager satisfies it as-is, and tests can stub it cheaply.
 */
import type { DiaryEntry, EventBus, MemoryEntry, ProposalTally } from "@contracts/types";
import { getAgentManager } from "../agents/AgentManager";
import type { CognitionSystem } from "../agents/Cognition";
import { getEventBus } from "../agents/events";
import { getTimeSystem } from "../world/instance";
import type { Speed } from "../world/TimeSystem";
import type { CognitionMetrics } from "../agents/Cognition";
import type { EventAttendanceSnapshot } from "../agents/EventBoard";
import { isPastEvent, PHASE_INDEX } from "../agents/Cognition";
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

  // -- v3 observability read-only seams (optional → existing stubs still typecheck) --
  /** Read-only cognition LLM spend, or null when cognition is absent/mock. */
  cognitionMetrics?(): Readonly<CognitionMetrics> | null;
  /** Attendance snapshot for one event, or undefined when unknown. */
  attendanceSnapshot?(eventId: string): EventAttendanceSnapshot | undefined;
  /** Soonest non-past event id to showcase, or null when none. */
  showcaseEventId?(): string | null;
  /** Wave 4c — tally of the current town proposal, or undefined when none. */
  governanceTally?(): ProposalTally | undefined;
  /** Diary — an agent's journal entries (oldest-first), or [] when absent. */
  diaryEntries?(agentName: string): DiaryEntry[];
  /** Diary — an agent's newest journal entry, or null when absent. */
  latestDiary?(agentName: string): DiaryEntry | null;
  /**
   * B-7 — the agent's real memory stream (the cognition memory store, as
   * stored). [] when the agent has none or when cognition is absent/mock. The
   * HUD caps/orders; this seam only EXPOSES the existing store (no mutation,
   * no fabrication).
   */
  memoryStream?(agentName: string): MemoryEntry[];
}

/**
 * Read one agent's memory stream off the cognition system (additive seam).
 * Pure + defensive: returns the store's entries as-stored, or [] when
 * cognition is absent (mock / server down) — never fabricates. Exposes the
 * EXISTING `CognitionSystem.memory.all()` data; touches no store internals.
 * Extracted so the seam is unit-testable without the live singletons.
 */
export function readMemoryStream(
  cognition: CognitionSystem | null,
  agentName: string,
): MemoryEntry[] {
  return cognition?.memory.all(agentName) ?? [];
}

export interface ObsConnection {
  bus: EventBus;
  controls: SimControls;
}

export function connectObservability(): ObsConnection {
  const manager = getAgentManager();

  // The three read-only observability seams reach the sim through AgentManager's
  // existing public `cognition()` getter — AgentManager source stays untouched.
  // Object.assign installs them onto the live manager so it satisfies the
  // extended (optional) SimControls surface without editing the class.
  const controls: SimControls = Object.assign(manager, {
    cognitionMetrics(): Readonly<CognitionMetrics> | null {
      const cog = manager.cognition();
      return cog ? cog.metricsSnapshot() : null;
    },
    attendanceSnapshot(eventId: string): EventAttendanceSnapshot | undefined {
      return manager.cognition()?.events.attendanceSnapshot(eventId);
    },
    showcaseEventId(): string | null {
      const cog = manager.cognition();
      if (cog === null) return null;
      const now = getTimeSystem().state();
      let best: { id: string; day: number; phaseIdx: number } | null = null;
      for (const e of cog.events.all()) {
        if (isPastEvent(e, now)) continue;
        const phaseIdx = PHASE_INDEX[e.phase];
        if (
          best === null ||
          e.day < best.day ||
          (e.day === best.day && phaseIdx < best.phaseIdx)
        ) {
          best = { id: e.id, day: e.day, phaseIdx };
        }
      }
      return best?.id ?? null;
    },
    governanceTally(): ProposalTally | undefined {
      const cog = manager.cognition();
      if (!cog) return undefined;
      const open = cog.governance.current();
      if (!open) return undefined;
      return cog.governance.tallySnapshot(open.id);
    },
    diaryEntries(agentName: string): DiaryEntry[] {
      return manager.cognition()?.diary.entries(agentName) ?? [];
    },
    latestDiary(agentName: string): DiaryEntry | null {
      return manager.cognition()?.diary.latest(agentName) ?? null;
    },
    memoryStream(agentName: string): MemoryEntry[] {
      return readMemoryStream(manager.cognition(), agentName);
    },
  });

  return { bus: getEventBus(), controls };
}
