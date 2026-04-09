/**
 * Shared domain types used across all backend interfaces.
 * These are backend-agnostic — no PocketBase or Firebase types leak through.
 */

/** Opaque user identity */
export interface User {
  id: string;
  email: string;
  name: string;
}

/** Cleanup function returned by all subscriptions */
export type Unsubscribe = () => void;

/** Event record used for activity tracking across apps */
export interface Event {
  id: string;
  subjectId: string;
  timestamp: Date;
  createdAt: Date;
  createdBy: string;
  data: Record<string, unknown>;
}

/** Visibility level for shared resources */
export type Visibility = "private" | "public" | "unlisted";

/** Notification preference */
export type NotificationMode = "all" | "subscribed" | "off";
