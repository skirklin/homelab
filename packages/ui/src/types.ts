// ===== User Profile Types =====

export type NotificationMode = "all" | "subscribed" | "off";

/**
 * Unified user profile type used across all apps.
 * Maps to fields on the PocketBase users collection.
 */
export interface UserProfile {
  shopping_slugs?: Record<string, string>;
  household_slugs?: Record<string, string>;
  travel_slugs?: Record<string, string>;
  upkeep_notification_mode?: NotificationMode;
  fcm_tokens?: string[];
  life_log_id?: string;
  last_task_notification?: string;
}

export type UserProfileStore = UserProfile;

/**
 * Unified event type for tracking activities across all apps.
 */
export interface Event {
  id: string;
  subjectId: string;
  timestamp: Date;
  createdAt: Date;
  createdBy: string;
  data: Record<string, unknown>;
}

/**
 * PocketBase storage format for Event — dates are ISO strings
 */
export interface EventStore {
  subject_id: string;
  timestamp: string;
  created_by: string;
  data: Record<string, unknown>;
}

export function eventFromStore(id: string, store: EventStore & { created: string }): Event {
  return {
    id,
    subjectId: store.subject_id,
    timestamp: new Date(store.timestamp),
    createdAt: new Date(store.created),
    createdBy: store.created_by,
    data: store.data || {},
  };
}

export function eventToStore(event: Omit<Event, "id">): EventStore {
  return {
    subject_id: event.subjectId,
    timestamp: event.timestamp.toISOString(),
    created_by: event.createdBy,
    data: event.data,
  };
}
