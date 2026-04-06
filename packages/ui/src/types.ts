import { Timestamp } from "firebase/firestore";

// ===== User Profile Types =====

/**
 * Notification mode for app-specific notifications.
 * - "all": Notify for all items
 * - "subscribed": Notify only for individually subscribed items
 * - "off": No notifications
 */
export type NotificationMode = "all" | "subscribed" | "off";

/**
 * Unified user profile type used across all apps.
 * Each app stores its data in separate fields to avoid conflicts.
 *
 * Stored in: users/{userId}
 */
export interface UserProfile {
  // Groceries app: maps slug to listId
  slugs?: Record<string, string>;

  // Upkeep app: maps slug to taskListId
  householdSlugs?: Record<string, string>;

  // Upkeep notification preference
  upkeepNotificationMode?: NotificationMode;

  // Shared FCM tokens for push notifications (used by upkeep & life tracker)
  fcmTokens?: string[];

  // Life tracker: user's life log ID
  lifeLogId?: string;

  // Upkeep: tracks last notification date to prevent duplicates
  lastTaskNotification?: string;
}

/**
 * Firestore storage format for UserProfile.
 * Same as UserProfile since all fields are already Firestore-compatible.
 */
export type UserProfileStore = UserProfile;

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
