/**
 * User profile interface — slug mappings, FCM tokens, notification preferences.
 *
 * Every app that supports multiple "lists" or "logs" uses slug mappings stored
 * on the user profile. This interface abstracts that shared pattern.
 */
import type { Unsubscribe, NotificationMode } from "../types/common";

export interface UserBackend {
  // --- Slug management (shared pattern across shopping, upkeep, travel) ---

  /**
   * Get all slug→ID mappings for a given slug namespace.
   * Namespaces: "shopping", "household", "travel"
   */
  getSlugs(userId: string, namespace: SlugNamespace): Promise<Record<string, string>>;

  /** Map a slug to a resource ID and add the user as an owner of that resource. */
  setSlug(userId: string, namespace: SlugNamespace, slug: string, resourceId: string): Promise<void>;

  /** Remove a slug mapping. */
  removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void>;

  /** Rename a slug (change the key, keep the resource ID). */
  renameSlug(userId: string, namespace: SlugNamespace, oldSlug: string, newSlug: string): Promise<void>;

  /**
   * Subscribe to slug changes for a namespace.
   * Callback receives the full current slugs map on every change.
   */
  subscribeSlugs(
    userId: string,
    namespace: SlugNamespace,
    onSlugs: (slugs: Record<string, string>) => void,
  ): Unsubscribe;

  // --- FCM tokens (push notifications) ---

  saveFcmToken(userId: string, token: string): Promise<void>;
  removeFcmToken(userId: string, token: string): Promise<void>;
  getFcmTokens(userId: string): Promise<string[]>;
  clearAllFcmTokens(userId: string): Promise<void>;

  // --- Notification preferences ---

  getNotificationMode(userId: string): Promise<NotificationMode>;
  setNotificationMode(userId: string, mode: NotificationMode): Promise<void>;

  // --- App-specific profile fields ---

  /** Update arbitrary profile fields (last_seen_update_version, etc.) */
  updateProfile(userId: string, fields: Record<string, unknown>): Promise<void>;

  /** Read the full user profile. */
  getProfile(userId: string): Promise<Record<string, unknown>>;
}

export type SlugNamespace = "shopping" | "household" | "travel";
