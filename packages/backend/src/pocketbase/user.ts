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
import type { WrappedPocketBase } from "../wrapped-pb";

const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "shopping_slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

export class PocketBaseUserBackend implements UserBackend {
  private wpb: WrappedPocketBase;
  /**
   * Per-(userId|field) promise chain used to serialize read-modify-write
   * operations against JSON columns (slug maps, fcm_tokens array). Two
   * concurrent callers in the same tab would otherwise both read the same
   * baseline, each compute a single-mutation map, each write back — last
   * write silently drops the other's change.
   *
   * Scope is in-memory per process, so cross-tab / cross-device races stay
   * possible but become rare: they require two writes landing inside the
   * same SSE round-trip, vs. the single-millisecond window between two
   * synchronous setSlug calls in one tab. The right long-term fix is a PB
   * JS hook that does the merge server-side; this is the near-term
   * mitigation. See $LINEAR_TODO for the hook plan.
   */
  private writeChains = new Map<string, Promise<unknown>>();

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase) {
    this.wpb = wpb;
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
    let cancelled = false;
    const field = SLUG_FIELDS[namespace];

    // wpb.subscribe(id) auto-loads the user record (delivered as a "create"
    // event), seeds the optimistic queue, then forwards live updates.
    //
    // Cancel-before-resolve guard: if the consumer unsubscribes before the
    // inner subscribe-promise lands, we still receive the underlying
    // teardown function — call it immediately so we don't leak a SSE
    // subscription + LocalSubscriber registration. This is the same shape
    // as the recipes / shopping / life cleanup races fixed earlier in the
    // week (c1bcf22, c63af4a, c6297e8).
    let unsub: (() => void) | null = null;
    let initialDone = false;
    this.wpb.collection("users").subscribe(userId, (e) => {
      if (cancelled) return;
      if (e.action === "delete") return;
      onSlugs((e.record as Record<string, unknown>)[field] as Record<string, string> || {});
    }).then((fn) => {
      if (cancelled) {
        // Teardown ran before the promise resolved. Drop the late-arriving
        // unsubscribe now so the underlying subscription isn't orphaned.
        try { fn(); } catch { /* nothing to do */ }
        return;
      }
      unsub = fn;
      if (!initialDone) {
        initialDone = true;
        // If the user record didn't exist (404 on initial getOne), no event
        // fired above. Emit empty slugs so consumers don't hang on the
        // initial-load promise.
        if (!this.wpb.collection("users").view(userId)) {
          onSlugs({});
        }
      }
    });

    return () => {
      cancelled = true;
      if (unsub) {
        try { unsub(); } catch { /* nothing to do */ }
        unsub = null;
      }
    };
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    // `fcm_tokens` is a JSON field, not a relation, so PB's `+=` array op
    // doesn't apply. Read current list (cache-first) and write merged.
    // Serialize against other fcm_tokens writes to keep cross-device
    // installs from clobbering each other.
    await this.withChain(`${userId}|fcm_tokens`, async () => {
      const user = await this.readUser(userId);
      const tokens = (user.fcm_tokens as string[] | undefined) || [];
      if (tokens.includes(token)) return;
      await this.wpb.collection("users").update(userId, { fcm_tokens: [...tokens, token] });
    });
  }

  async removeFcmToken(userId: string, token: string): Promise<void> {
    await this.withChain(`${userId}|fcm_tokens`, async () => {
      const user = await this.readUser(userId);
      const tokens = (user.fcm_tokens as string[] | undefined) || [];
      await this.wpb.collection("users").update(userId, {
        fcm_tokens: tokens.filter((t) => t !== token),
      });
    });
  }

  async getFcmTokens(userId: string): Promise<string[]> {
    const user = await this.readUser(userId);
    return (user.fcm_tokens as string[] | undefined) || [];
  }

  async clearAllFcmTokens(userId: string): Promise<void> {
    await this.withChain(`${userId}|fcm_tokens`, async () => {
      await this.wpb.collection("users").update(userId, { fcm_tokens: [] });
    });
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
