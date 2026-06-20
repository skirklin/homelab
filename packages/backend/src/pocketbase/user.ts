/**
 * PocketBase implementation of UserBackend.
 *
 * Writes route through the optimistic wrapper. Slug subscription rides on
 * the PBMirror — a single record-topic slice on `users:userId`, with the
 * mirror handling cancel-before-resolve, SSE coalescing, and queue overlay
 * so optimistic slug edits / timezone pushes are visible synchronously.
 */
import type PocketBase from "pocketbase";
import type { UserBackend, SlugNamespace, PushSubscriptionInfo } from "../interfaces/user";
import type { NotificationMode, Unsubscribe } from "../types/common";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror } from "../wrapped-pb/mirror";

const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "shopping_slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

export class PocketBaseUserBackend implements UserBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;
  /**
   * Per-(userId|field) promise chain used to serialize read-modify-write
   * operations against JSON columns (slug maps). Two
   * concurrent callers in the same tab would otherwise both read the same
   * baseline, each compute a single-mutation map, each write back — last
   * write silently drops the other's change.
   *
   * Scope is in-memory per process, so cross-tab / cross-device races stay
   * possible but become rare: they require two writes landing inside the
   * same SSE round-trip, vs. the single-millisecond window between two
   * synchronous setSlug calls in one tab. The right long-term fix is a PB
   * JS hook that does the merge server-side; this is the near-term
   * mitigation. (No tracking issue for the hook.)
   */
  private writeChains = new Map<string, Promise<unknown>>();

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
  }

  /**
   * Serialize `task` against any in-flight operation sharing `chainKey`.
   * The chain stores the most recent tail; we await it, run the task, then
   * publish our own promise as the new tail. Errors don't break the chain —
   * later tasks must still run even if a predecessor rejected.
   */
  private async withChain<T>(chainKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(chainKey);
    // Await prior tail but swallow its error so a rejected slug write
    // doesn't poison every subsequent op for that user+field.
    const wait = prev ? prev.catch(() => undefined) : Promise.resolve();
    const next = wait.then(task);
    this.writeChains.set(chainKey, next);
    try {
      return await next;
    } finally {
      // Only clear if we're still the tail — a later call may have chained
      // onto us in the meantime.
      if (this.writeChains.get(chainKey) === next) {
        this.writeChains.delete(chainKey);
      }
    }
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
    const field = SLUG_FIELDS[namespace];
    await this.withChain(`${userId}|${field}`, async () => {
      const user = await this.readUser(userId);
      const existing = (user[field] as Record<string, string> | undefined) || {};
      const slugs = { ...existing, [slug]: resourceId };
      await this.wpb.collection("users").update(userId, { [field]: slugs }, { $autoCancel: false });
    });
  }

  async removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void> {
    const field = SLUG_FIELDS[namespace];
    await this.withChain(`${userId}|${field}`, async () => {
      const user = await this.readUser(userId);
      const slugs = { ...((user[field] as Record<string, string> | undefined) || {}) };
      delete slugs[slug];
      await this.wpb.collection("users").update(userId, { [field]: slugs });
    });
  }

  async renameSlug(userId: string, namespace: SlugNamespace, oldSlug: string, newSlug: string): Promise<void> {
    const field = SLUG_FIELDS[namespace];
    await this.withChain(`${userId}|${field}`, async () => {
      const user = await this.readUser(userId);
      const slugs = { ...((user[field] as Record<string, string> | undefined) || {}) };
      if (slugs[oldSlug]) {
        slugs[newSlug] = slugs[oldSlug];
        delete slugs[oldSlug];
        await this.wpb.collection("users").update(userId, { [field]: slugs });
      }
    });
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
    // One record-topic slice on the user. The mirror handles
    // cancel-before-resolve and queue overlay; when the record doesn't
    // exist yet the slice emits an empty array, which we surface as an
    // empty slugs map so consumers don't hang on initial load.
    const field = SLUG_FIELDS[namespace];
    const handle = this.mirror.watch(
      { collection: "users", topic: userId },
      (records) => {
        if (records.length === 0) {
          onSlugs({});
          return;
        }
        onSlugs(
          ((records[0] as Record<string, unknown>)[field] as Record<string, string>) || {},
        );
      },
    );
    return () => handle.unsubscribe();
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscriptionInfo[]> {
    const rows = await this.wpb.collection("push_subscriptions").getFullList({
      filter: `user = "${userId}"`,
      sort: "-created",
    });
    return rows.map((r) => ({
      id: r.id,
      origin: (r.origin as string) || "",
      endpoint: (r.endpoint as string) || "",
      created: r.created as string,
    }));
  }

  async clearPushSubscriptions(userId: string): Promise<void> {
    const rows = await this.wpb.collection("push_subscriptions").getFullList({
      filter: `user = "${userId}"`,
    });
    await Promise.all(rows.map((r) => this.wpb.collection("push_subscriptions").delete(r.id)));
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

  async resolveNames(ids: string[]): Promise<Array<{ id: string; name: string }>> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return [];
    const pb = this.pb();
    const filter = unique.map((id) => pb.filter("id = {:id}", { id })).join(" || ");
    const records = await pb
      .collection("user_names")
      .getFullList({ filter, fields: "id,name", $autoCancel: false });
    return records.map((r) => ({ id: r.id, name: (r as { name?: string }).name || "" }));
  }
}
