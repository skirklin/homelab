// ===== Re-exports from @homelab/backend =====
//
// LifeEvent / LifeEntry are the canonical event types — re-exported here so
// the rest of the monorepo can keep importing them from @kirkl/shared
// without crossing the internal package boundary.
//
// The old free-form Event / EventStore / eventFromStore / eventToStore
// helpers were retired once task_events + recipe_events migrated to the
// unified entries[] shape (commits 3f8ea6c / a1cf8f8). Use LifeEvent
// (or the per-domain TaskCompletion / CookingLogEvent) instead.

export type { LifeEvent, LifeEntry, PushSubscriptionInfo } from "@homelab/backend";

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
  last_task_notification?: string;
}

export type UserProfileStore = UserProfile;
