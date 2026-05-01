/**
 * PocketBase implementation of UserBackend.
 *
 * Writes route through the optimistic wrapper. Slug subscription uses wpb
 * so optimistic profile mutations (e.g. timezone push, slug rename) flow
 * to subscribers immediately.
 */
import type PocketBase from "pocketbase";
import type { UserBackend, SlugNamespace } from "../interfaces/user";
import type { NotificationMode, Unsubscribe } from "../types/common";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "shopping_slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

export class PocketBaseUserBackend implements UserBackend {
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
  }

  async getSlugs(userId: string, namespace: SlugNamespace): Promise<Record<string, string>> {
    try {
      const user = await this.readUser(userId);
      return (user[SLUG_FIELDS[namespace]] as Record<string, string> | undefined) || {};
    } catch {
      return {};
    }
  }

  async setSlug(userId: string, namespace: SlugNamespace, slug: string, resourceId: string): Promise<void> {
    const user = await this.readUser(userId);
    const field = SLUG_FIELDS[namespace];
    const existing = (user[field] as Record<string, string> | undefined) || {};
    const slugs = { ...existing, [slug]: resourceId };
    await this.wpb.collection("users").update(userId, { [field]: slugs }, { $autoCancel: false });
  }

  async removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void> {
    const user = await this.readUser(userId);
    const field = SLUG_FIELDS[namespace];
    const slugs = { ...((user[field] as Record<string, string> | undefined) || {}) };
    delete slugs[slug];
    await this.wpb.collection("users").update(userId, { [field]: slugs });
  }

  async renameSlug(userId: string, namespace: SlugNamespace, oldSlug: string, newSlug: string): Promise<void> {
    const user = await this.readUser(userId);
    const field = SLUG_FIELDS[namespace];
    const slugs = { ...((user[field] as Record<string, string> | undefined) || {}) };
    if (slugs[oldSlug]) {
      slugs[newSlug] = slugs[oldSlug];
      delete slugs[oldSlug];
      await this.wpb.collection("users").update(userId, { [field]: slugs });
    }
  }

  /**
   * Read the user record. Prefer the wpb in-memory cache (already populated
   * by an active subscription — `subscribeSlugs`, `useTimezoneSync`, etc.) so
   * slug edits don't pay a `getOne` round-trip in the common case.
   */
  private async readUser(userId: string): Promise<Record<string, unknown>> {
    const cached = this.wpb.collection("users").view<Record<string, unknown>>(userId);
    if (cached) return cached;
    return await this.pb().collection("users").getOne(userId, { $autoCancel: false }) as unknown as Record<string, unknown>;
  }

  subscribeSlugs(
    userId: string,
    namespace: SlugNamespace,
    onSlugs: (slugs: Record<string, string>) => void,
  ): Unsubscribe {
    let cancelled = false;
    const field = SLUG_FIELDS[namespace];

    // Fetch initial
    this.pb().collection("users").getOne(userId, { $autoCancel: false }).then((record) => {
      if (!cancelled) onSlugs(record[field] || {});
    }).catch(() => {
      if (!cancelled) onSlugs({});
    });

    // Subscribe to changes — optimistic-aware via wpb.
    let unsub: (() => void) | undefined;
    this.wpb.collection("users").subscribe(userId, (e) => {
      if (cancelled) return;
      if (e.action === "update") {
        onSlugs((e.record as Record<string, unknown>)[field] as Record<string, string> || {});
      }
    }).then((fn) => { unsub = fn; });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    // `fcm_tokens` is a JSON field, not a relation, so PB's `+=` array op
    // doesn't apply. Read current list (cache-first) and write merged.
    const user = await this.readUser(userId);
    const tokens = (user.fcm_tokens as string[] | undefined) || [];
    if (tokens.includes(token)) return;
    await this.wpb.collection("users").update(userId, { fcm_tokens: [...tokens, token] });
  }

  async removeFcmToken(userId: string, token: string): Promise<void> {
    const user = await this.readUser(userId);
    const tokens = (user.fcm_tokens as string[] | undefined) || [];
    await this.wpb.collection("users").update(userId, {
      fcm_tokens: tokens.filter((t) => t !== token),
    });
  }

  async getFcmTokens(userId: string): Promise<string[]> {
    const user = await this.readUser(userId);
    return (user.fcm_tokens as string[] | undefined) || [];
  }

  async clearAllFcmTokens(userId: string): Promise<void> {
    await this.wpb.collection("users").update(userId, { fcm_tokens: [] });
  }

  async getNotificationMode(userId: string): Promise<NotificationMode> {
    const user = await this.readUser(userId);
    return (user.upkeep_notification_mode as NotificationMode | undefined) || "off";
  }

  async setNotificationMode(userId: string, mode: NotificationMode): Promise<void> {
    await this.wpb.collection("users").update(userId, { upkeep_notification_mode: mode });
  }

  async updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
    await this.wpb.collection("users").update(userId, fields);
  }

  async getProfile(userId: string): Promise<Record<string, unknown>> {
    return this.readUser(userId);
  }
}
