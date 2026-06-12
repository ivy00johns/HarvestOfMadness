/**
 * EventBus singleton — ring buffer (cap 1000) implementing the contract
 * EventBus. agents-agent emits (every decision = turn_start -> llm_call ->
 * action_chosen -> action_resolved under one turnId, plus domain events);
 * obs-agent consumes. Headless-safe: no Phaser/world imports.
 */
import type { EventBus, WorldEvent } from "@contracts/types";

export const EVENT_RING_CAP = 1000;

class RingEventBus implements EventBus {
  private buffer: WorldEvent[] = [];
  private seq = 0;
  private readonly subs = new Set<(e: WorldEvent) => void>();

  emit(e: Omit<WorldEvent, "seq" | "ts">): void {
    const evt: WorldEvent = { ...e, seq: ++this.seq, ts: Date.now() };
    this.buffer.push(evt);
    if (this.buffer.length > EVENT_RING_CAP) {
      this.buffer.splice(0, this.buffer.length - EVENT_RING_CAP);
    }
    for (const cb of this.subs) {
      try {
        cb(evt);
      } catch {
        /* a broken subscriber must never break the pipeline */
      }
    }
  }

  on(cb: (e: WorldEvent) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** newest-last snapshot, at most `limit` (default: full ring). */
  recent(limit: number = EVENT_RING_CAP): WorldEvent[] {
    return this.buffer.slice(-Math.max(0, limit));
  }
}

let bus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!bus) bus = new RingEventBus();
  return bus;
}

/** Test-only escape hatch (mirrors resetWorldForTests). */
export function resetEventBusForTests(): void {
  bus = null;
}
