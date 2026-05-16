/**
 * Supabase implementation of UserBackend.
 *
 * Profile data lives in `public.user_profiles` (1:1 with `auth.users`).
 * RLS allows a user to read/update only their own row. Reads + writes are
 * read-modify-write on JSONB columns; upserts create the row on first
 * write so freshly-signed-up users don't need a separate provisioning
 * step before the apps can touch their profile.
 *
 * No optimistic write layer yet — Phase 3 first cut.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { UserBackend, SlugNamespace } from "../interfaces/user";
import type { NotificationMode, Unsubscribe } from "../types/common";

const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "shopping_slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

interface UserProfileRow {
  id: string;
  shopping_slugs: Record<string, string> | null;
  household_slugs: Record<string, string> | null;
  travel_slugs: Record<string, string> | null;
  recipe_boxes: Record<string, string> | null;
  fcm_tokens: string[] | null;
  upkeep_notification_mode: NotificationMode | null;
  last_task_notification: string | null;
  cooking_mode_seen: boolean | null;
  last_seen_update_version: number | null;
  travel_notif_state: Record<string, unknown> | null;
  timezone: string | null;
  name: string | null;
  avatar_url: string | null;
  life_log_id: string | null;
  legacy_pb_id: string | null;
  created_at: string;
  updated_at: string;
}

export class SupabaseUserBackend implements UserBackend {
  constructor(private client: SupabaseClient) {}

  async getSlugs(userId: string, namespace: SlugNamespace): Promise<Record<string, string>> {
    const row = await this.readProfile(userId);
    if (!row) return {};
    const field = SLUG_FIELDS[namespace] as keyof UserProfileRow;
    return (row[field] as Record<string, string> | null) ?? {};
  }

  async setSlug(
    userId: string,
    namespace: SlugNamespace,
    slug: string,
    resourceId: string,
  ): Promise<void> {
    const field = SLUG_FIELDS[namespace];
    const existing = await this.getSlugs(userId, namespace);
    const next = { ...existing, [slug]: resourceId };
    await this.upsertProfile(userId, { [field]: next });
  }

  async removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void> {
    const field = SLUG_FIELDS[namespace];
    const next = { ...(await this.getSlugs(userId, namespace)) };
    delete next[slug];
    await this.upsertProfile(userId, { [field]: next });
  }

  async renameSlug(
    userId: string,
    namespace: SlugNamespace,
    oldSlug: string,
    newSlug: string,
  ): Promise<void> {
    const field = SLUG_FIELDS[namespace];
    const next = { ...(await this.getSlugs(userId, namespace)) };
    if (!(oldSlug in next)) return;
    next[newSlug] = next[oldSlug];
    delete next[oldSlug];
    await this.upsertProfile(userId, { [field]: next });
  }

  subscribeSlugs(
    userId: string,
    namespace: SlugNamespace,
    onSlugs: (slugs: Record<string, string>) => void,
  ): Unsubscribe {
    let cancelled = false;
    const field = SLUG_FIELDS[namespace];

    const channel: RealtimeChannel = this.client
      .channel(`user-profile-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_profiles",
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            onSlugs({});
            return;
          }
          const row = payload.new as UserProfileRow;
          onSlugs((row[field as keyof UserProfileRow] as Record<string, string> | null) ?? {});
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || cancelled) return;
        // Emit initial state once the channel is live. If the profile row
        // doesn't exist yet (new user), emit empty so consumers don't hang.
        const row = await this.readProfile(userId);
        if (cancelled) return;
        const slugs = (row?.[field as keyof UserProfileRow] as Record<string, string> | null) ?? {};
        onSlugs(slugs);
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(channel);
    };
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    const tokens = await this.getFcmTokens(userId);
    if (tokens.includes(token)) return;
    await this.upsertProfile(userId, { fcm_tokens: [...tokens, token] });
  }

  async removeFcmToken(userId: string, token: string): Promise<void> {
    const tokens = await this.getFcmTokens(userId);
    await this.upsertProfile(userId, { fcm_tokens: tokens.filter((t) => t !== token) });
  }

  async getFcmTokens(userId: string): Promise<string[]> {
    const row = await this.readProfile(userId);
    return row?.fcm_tokens ?? [];
  }

  async clearAllFcmTokens(userId: string): Promise<void> {
    await this.upsertProfile(userId, { fcm_tokens: [] });
  }

  async getNotificationMode(userId: string): Promise<NotificationMode> {
    const row = await this.readProfile(userId);
    return row?.upkeep_notification_mode ?? "off";
  }

  async setNotificationMode(userId: string, mode: NotificationMode): Promise<void> {
    await this.upsertProfile(userId, { upkeep_notification_mode: mode });
  }

  async updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
    await this.upsertProfile(userId, fields);
  }

  async getProfile(userId: string): Promise<Record<string, unknown>> {
    const row = await this.readProfile(userId);
    // Match the PB shape (which returned a flat record of all fields).
    return row ? (row as unknown as Record<string, unknown>) : {};
  }

  // ---- Internal helpers --------------------------------------------------

  private async readProfile(userId: string): Promise<UserProfileRow | null> {
    const { data, error } = await this.client
      .from("user_profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as UserProfileRow | null) ?? null;
  }

  /**
   * Upsert by primary key (id). Creates the row on first write so consumers
   * don't need a separate provisioning step after sign-up.
   */
  private async upsertProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
    const { error } = await this.client
      .from("user_profiles")
      .upsert({ id: userId, ...fields }, { onConflict: "id" });
    if (error) throw error;
  }
}
