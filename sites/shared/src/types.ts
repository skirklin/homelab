import { Timestamp } from "firebase/firestore";

/**
 * Unified event type for tracking activities across all apps.
 * Used for life tracker entries, upkeep completions, and recipe cooking logs.
 *
 * The `data` field contains all type-specific payload including optional notes.
 * Examples:
 *   - Recipe cooking: { notes?: string }
 *   - Life rating: { rating: 4, notes?: string }
 *   - Upkeep completion: { notes?: string }
 */
export interface Event {
  id: string;
  subjectId: string;      // widgetId, taskId, or recipeId
  timestamp: Date;        // when the event occurred
  createdAt: Date;        // when it was logged
  createdBy: string;      // userId
  data: Record<string, unknown>;
}

/**
 * Firestore storage format for Event
 */
export interface EventStore {
  subjectId: string;
  timestamp: Timestamp;
  createdAt: Timestamp;
  createdBy: string;
  data: Record<string, unknown>;
}

/**
 * Convert from Firestore storage format to Event
 */
export function eventFromStore(id: string, store: EventStore): Event {
  return {
    id,
    subjectId: store.subjectId,
    timestamp: store.timestamp.toDate(),
    createdAt: store.createdAt.toDate(),
    createdBy: store.createdBy,
    data: store.data,
  };
}

/**
 * Convert Event to Firestore storage format (without id)
 */
export function eventToStore(event: Omit<Event, "id">): EventStore {
  return {
    subjectId: event.subjectId,
    timestamp: Timestamp.fromDate(event.timestamp),
    createdAt: Timestamp.fromDate(event.createdAt),
    createdBy: event.createdBy,
    data: event.data,
  };
}
