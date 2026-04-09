/**
 * Firebase/Firestore implementation of UserBackend.
 *
 * Data model:
 *   users/{userId} — user profile document with:
 *     - slugs: Record<string, string> (Firebase used a single "slugs" field)
 *     - fcm_tokens: string[]
 *     - upkeep_notification_mode: string
 *
 * Note: Firebase used a flat "slugs" field for shopping only.
 * This implementation maps the namespace-based interface to the flat structure
 * for backwards compatibility, while supporting multiple namespaces if the
 * Firestore schema is extended.
 */
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  type Firestore,
} from "firebase/firestore";
import type { UserBackend, SlugNamespace } from "../interfaces/user";
import type { NotificationMode, Unsubscribe } from "../types/common";

// Firebase used different field names for slug storage
const SLUG_FIELDS: Record<SlugNamespace, string> = {
  shopping: "slugs",
  household: "household_slugs",
  travel: "travel_slugs",
};

export class FirebaseUserBackend implements UserBackend {
  constructor(private db: Firestore) {}

  private userRef(userId: string) {
    return doc(this.db, "users", userId);
  }

  async getSlugs(userId: string, namespace: SlugNamespace): Promise<Record<string, string>> {
    const snap = await getDoc(this.userRef(userId));
    if (!snap.exists()) return {};
    return snap.data()[SLUG_FIELDS[namespace]] || {};
  }

  async setSlug(userId: string, namespace: SlugNamespace, slug: string, resourceId: string): Promise<void> {
    const ref = this.userRef(userId);
    const field = SLUG_FIELDS[namespace];
    const snap = await getDoc(ref);

    if (snap.exists()) {
      const slugs = { ...snap.data()[field], [slug]: resourceId };
      await updateDoc(ref, { [field]: slugs });
    } else {
      await setDoc(ref, { [field]: { [slug]: resourceId } });
    }

    // Add user to resource owners (for shopping lists)
    if (namespace === "shopping") {
      const listRef = doc(this.db, "lists", resourceId);
      await updateDoc(listRef, { owners: arrayUnion(userId) });
    }
  }

  async removeSlug(userId: string, namespace: SlugNamespace, slug: string): Promise<void> {
    const ref = this.userRef(userId);
    const field = SLUG_FIELDS[namespace];
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const slugs = { ...snap.data()[field] };
    delete slugs[slug];
    await updateDoc(ref, { [field]: slugs });
  }

  async renameSlug(userId: string, namespace: SlugNamespace, oldSlug: string, newSlug: string): Promise<void> {
    const ref = this.userRef(userId);
    const field = SLUG_FIELDS[namespace];
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const slugs = { ...snap.data()[field] };
    if (slugs[oldSlug]) {
      slugs[newSlug] = slugs[oldSlug];
      delete slugs[oldSlug];
      await updateDoc(ref, { [field]: slugs });
    }
  }

  subscribeSlugs(
    userId: string,
    namespace: SlugNamespace,
    onSlugs: (slugs: Record<string, string>) => void,
  ): Unsubscribe {
    const field = SLUG_FIELDS[namespace];
    return onSnapshot(this.userRef(userId), (snap) => {
      if (snap.exists()) {
        onSlugs(snap.data()[field] || {});
      } else {
        onSlugs({});
      }
    });
  }

  async saveFcmToken(userId: string, token: string): Promise<void> {
    await updateDoc(this.userRef(userId), { fcm_tokens: arrayUnion(token) });
  }

  async removeFcmToken(userId: string, token: string): Promise<void> {
    await updateDoc(this.userRef(userId), { fcm_tokens: arrayRemove(token) });
  }

  async getFcmTokens(userId: string): Promise<string[]> {
    const snap = await getDoc(this.userRef(userId));
    return snap.exists() ? snap.data().fcm_tokens || [] : [];
  }

  async clearAllFcmTokens(userId: string): Promise<void> {
    await updateDoc(this.userRef(userId), { fcm_tokens: [] });
  }

  async getNotificationMode(userId: string): Promise<NotificationMode> {
    const snap = await getDoc(this.userRef(userId));
    return snap.exists() ? snap.data().upkeep_notification_mode || "off" : "off";
  }

  async setNotificationMode(userId: string, mode: NotificationMode): Promise<void> {
    await updateDoc(this.userRef(userId), { upkeep_notification_mode: mode });
  }

  async updateProfile(userId: string, fields: Record<string, unknown>): Promise<void> {
    await updateDoc(this.userRef(userId), fields);
  }

  async getProfile(userId: string): Promise<Record<string, unknown>> {
    const snap = await getDoc(this.userRef(userId));
    return snap.exists() ? snap.data() : {};
  }
}
