/**
 * User backend cache decorator.
 *
 * Slug maps drive routing in every "list-aware" app, so caching them
 * is what makes the app reach the right URL when offline.
 */
import type { UserBackend, SlugNamespace } from "../interfaces/user";
import type { Unsubscribe, NotificationMode } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withUserCache(inner: UserBackend): UserBackend {
  return {
    getSlugs: (userId, ns) =>
      cachedRead<Record<string, string>>(`user:slugs:${userId}:${ns}`, () => inner.getSlugs(userId, ns)),
    getFcmTokens: (id) => cachedRead<string[]>(`user:fcm:${id}`, () => inner.getFcmTokens(id)),
    getNotificationMode: (id) =>
      cachedRead<NotificationMode>(`user:notifMode:${id}`, () => inner.getNotificationMode(id)),
    getProfile: (id) => cachedRead<Record<string, unknown>>(`user:profile:${id}`, () => inner.getProfile(id)),

    setSlug: (id, ns, s, r) => inner.setSlug(id, ns, s, r),
    removeSlug: (id, ns, s) => inner.removeSlug(id, ns, s),
    renameSlug: (id, ns, o, n) => inner.renameSlug(id, ns, o, n),
    saveFcmToken: (id, t) => inner.saveFcmToken(id, t),
    removeFcmToken: (id, t) => inner.removeFcmToken(id, t),
    clearAllFcmTokens: (id) => inner.clearAllFcmTokens(id),
    setNotificationMode: (id, m) => inner.setNotificationMode(id, m),
    updateProfile: (id, f) => inner.updateProfile(id, f),

    subscribeSlugs(userId: string, namespace: SlugNamespace, onSlugs): Unsubscribe {
      const key = `user:slugs:${userId}:${namespace}`;
      const h = hydrateOne<Record<string, string>>(key, onSlugs);
      return inner.subscribeSlugs(
        userId,
        namespace,
        cached(key, (slugs) => {
          h.live();
          onSlugs(slugs);
        }),
      );
    },
  };
}
