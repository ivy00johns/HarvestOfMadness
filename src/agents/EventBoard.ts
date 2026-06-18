/**
 * EventBoard — lightweight in-memory registry of seeded SimEvents and which
 * agents know about them. Owned by CognitionSystem; no framework dependencies.
 *
 * v3 — smallville party-emergence design: event_seeded → knowledge diffuses
 * via conversation (onTalk) → knownEvents surfaces in enrichObservation.
 */
import type { SimEvent } from "@contracts/types";

/**
 * Read-only attendance view of a single event, for the observability HUD's
 * live party showcase. `invited` = knowers minus the host. Pure snapshot —
 * the arrays are fresh copies, mutating them never leaks into the board.
 */
export interface EventAttendanceSnapshot {
  event: SimEvent;
  knowers: string[];
  invited: string[];
  knowerCount: number;
}

export class EventBoard {
  private readonly events = new Map<string, SimEvent>();
  /** eventId -> set of agent names who know about it */
  private readonly knowledge = new Map<string, Set<string>>();

  /** Seed a new event; the host automatically knows it. */
  seed(event: SimEvent): void {
    this.events.set(event.id, event);
    this.markKnows(event.id, event.host);
  }

  /** All seeded events. */
  all(): SimEvent[] {
    return [...this.events.values()];
  }

  /** Get a single event by id. */
  get(id: string): SimEvent | undefined {
    return this.events.get(id);
  }

  /**
   * Record that an agent knows about an event.
   * Returns true if this agent did NOT already know it (newly learned).
   */
  markKnows(eventId: string, agentName: string): boolean {
    const set = this.knowledge.get(eventId) ?? new Set<string>();
    const isNew = !set.has(agentName);
    set.add(agentName);
    this.knowledge.set(eventId, set);
    return isNew;
  }

  /** Does the named agent know about this event? */
  knows(eventId: string, agentName: string): boolean {
    return this.knowledge.get(eventId)?.has(agentName) ?? false;
  }

  /** All events known by a specific agent. */
  knownBy(agentName: string): SimEvent[] {
    return this.all().filter((e) => this.knows(e.id, agentName));
  }

  /** How many agents know about this event. */
  knowerCount(eventId: string): number {
    return this.knowledge.get(eventId)?.size ?? 0;
  }

  /**
   * Read-only attendance snapshot for the HUD. Returns undefined when the
   * event is unknown. `invited` excludes the host (the host seeds, never
   * gets invited). Arrays are fresh copies — non-mutating by construction.
   */
  attendanceSnapshot(eventId: string): EventAttendanceSnapshot | undefined {
    const event = this.events.get(eventId);
    if (!event) return undefined;
    const knowers = [...(this.knowledge.get(eventId) ?? new Set<string>())];
    return {
      event,
      knowers,
      invited: knowers.filter((n) => n !== event.host),
      knowerCount: knowers.length,
    };
  }
}
