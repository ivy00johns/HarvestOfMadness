/**
 * TimeSystem — day/phase clock. Pure logic, no Phaser; the scene feeds it
 * real elapsed milliseconds via tick(deltaMs).
 *
 * Rules (mission §7 + contracts):
 * - phases auto-advance morning -> afternoon -> evening -> night as real time
 *   accumulates: one phase per PHASE_DURATION_MS at speed 1 (delta is scaled
 *   by the global speed multiplier, so speed 2 = phases twice as fast).
 * - night NEVER auto-rolls to morning; only advanceDay() (SLEEP) does.
 * - step() advances exactly one phase (no-op at night).
 */
import type { Phase, TimeState } from "@contracts/types";
import { PHASE_DURATION_MS } from "../config";

const PHASE_ORDER: readonly Phase[] = ["morning", "afternoon", "evening", "night"];

export type Speed = 0.5 | 1 | 2 | 4;

export class TimeSystem {
  private day = 1;
  private phaseIndex = 0;
  private speed: Speed = 1;
  private paused = false;
  private accumulatedMs = 0;
  private readonly phaseDurationMs: number;
  private readonly listeners = new Set<(t: TimeState) => void>();

  constructor(phaseDurationMs: number = PHASE_DURATION_MS) {
    this.phaseDurationMs = phaseDurationMs;
  }

  state(): TimeState {
    return { day: this.day, phase: PHASE_ORDER[this.phaseIndex] };
  }

  getSpeed(): Speed {
    return this.speed;
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Feed real elapsed ms; advances phases (but never past night). */
  tick(deltaMs: number): void {
    if (this.paused || this.phaseIndex === PHASE_ORDER.length - 1) return;
    this.accumulatedMs += deltaMs * this.speed;
    while (
      this.accumulatedMs >= this.phaseDurationMs &&
      this.phaseIndex < PHASE_ORDER.length - 1
    ) {
      this.accumulatedMs -= this.phaseDurationMs;
      this.phaseIndex++;
      this.notify();
    }
    // Parked at night: discard leftover so morning starts fresh after sleep.
    if (this.phaseIndex === PHASE_ORDER.length - 1) this.accumulatedMs = 0;
  }

  /** Manually advance one phase; no-op at night (sleep owns the day roll). */
  step(): void {
    if (this.phaseIndex >= PHASE_ORDER.length - 1) return;
    this.phaseIndex++;
    this.accumulatedMs = 0;
    this.notify();
  }

  /** SLEEP semantics: next day, morning. Crop growth is World's job. */
  advanceDay(): void {
    this.day++;
    this.phaseIndex = 0;
    this.accumulatedMs = 0;
    this.notify();
  }

  /** Subscribe to phase/day changes; returns unsubscribe. */
  onChange(cb: (t: TimeState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    const snapshot = this.state();
    for (const cb of this.listeners) cb(snapshot);
  }
}
