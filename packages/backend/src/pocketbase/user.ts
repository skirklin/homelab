/**
 * PocketBase implementation of UserBackend.
 */
import type PocketBase from "pocketbase";
import type { UserBackend, SlugNamespace } from "../interfaces/user";
import type { NotificationMode, Unsubscribe } from "../types/common";

const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "shopping_slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

export class PocketBaseUserBackend implements UserBackend {
  constructor(private pb: () => PocketBase) {}

  async getSlugs(userId: string, namespace: SlugNamespace): Promise<Record<string, string>> {
    try {
      const user = await this.pb().collection("users").getOne(userId, { $autoCancel: false });
      return user[SLUG_FIELDS[namespace]] || {};
    } catch {
      return {};
    }
  }

  async setSlug(userId: string, namespace: SlugNamespace, slug: string, resourceId: string): Promise<void> {
    const opts = { $autoCancel: false };
    const user = await this.pb().collection("users").getOne(userId, opts);
    const field = SLUG_FIELDS[namespace];
    const slugs = { ...(user[field] || {}), [slug]: resourceId };
    await this.pb().collection("users").update(userId, { [field]: slugs }, opts);
  }

  async removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void> {
    const user = await this.pb().collection("users").getOne(userId);
    const field = SLUG_FIELDS[namespace];
    const slugs = { ...(user[field] || {}) };
    delete slugs[slug];
    await this.pb().collection("users").update(userId, { [field]: slugs });
  }

  async renameSlug(userId: string, namespace: SlugNamespace, oldSlug: string, newSlug: string): Promise<void> {
    const user = await this.pb().collection("users").getOne(userId);
    const field = SLUG_FIELDS[namespace];
    const slugs = { ...(user[field] || {}) };
    if (slugs[oldSlug]) {
      slugs[newSlug] = slugs[oldSlug];
      delete slugs[oldSlug];
      await this.pb().collection("users").update(userId, { [field]: slugs });
    }
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

    // Subscribe to changes
    this.pb().collection("users").subscribe(userId, (e) => {
      if (cancelled) return;
      if (e.action === "update") {
        onSlugs(e.record[field] || {});
      }
    });

    return () => {
      cancelled = true;
      this.pb().collection("users").unsubscribe(userId);
    };
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    const user = await this.pb().collection("users").getOne(userId);
    const tokens: string[] = user.fcm_tokens || [];
    if (!tokens.includes(token)) {
      await this.pb().collection("users").update(userId, { "fcm_tokens+": token });
    }
  }

  async removeFcmToken(userId: string, token: string): Promise<void> {
    await this.pb().collection("users").update(userId, { "fcm_tokens-": token });
  }

  async getFcmTokens(userId: string): Promise<string[]> {
    const user = await this.pb().collection("users").getOne(userId);
    return user.fcm_tokens || [];
  }

  async clearAllFcmTokens(userId: string): Promise<void> {
    await this.pb().collection("users").update(userId, { fcm_tokens: [] });
  }

  async getNotificationMode(userId: string): Promise<NotificationMode> {
    const user = await this.pb().collection("users").getOne(userId);
    return user.upkeep_notification_mode || "off";
  }

  async setNotificationMode(userId: string, mode: NotificationMode): Promise<void> {
    await this.pb().collection("users").update(userId, { upkeep_notification_mode: mode });
  }

  async updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
    await this.pb().collection("users").update(userId, fields);
  }

  async getProfile(userId: string): Promise<Record<string, unknown>> {
    const user = await this.pb().collection("users").getOne(userId);
    return user as unknown as Record<string, unknown>;
  }
}
