/**
 * Web Push notification support for the Life Tracker app.
 * Uses the standard Push API with VAPID keys (replaces FCM).
 */

import { getApiBase, getAuthHeaders } from "@kirkl/shared";

// vite-plugin-pwa generates the SW at /sw.js and importScripts() the
// existing /push-sw.js push handler into it (see vite.config.ts).
const SW_PATH = "/sw.js";

/** Convert a base64url-encoded VAPID public key to a Uint8Array for subscribe(). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

let vapidPublicKey: string | null = null;

async function getVapidKey(): Promise<string | null> {
  if (vapidPublicKey) return vapidPublicKey;
  try {
    const res = await fetch(`${getApiBase()}/push/vapid-key`);
    if (!res.ok) return null;
    const data = await res.json() as { publicKey: string };
    vapidPublicKey = data.publicKey;
    return vapidPublicKey;
  } catch {
    return null;
  }
}

function isNotificationSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

/** True only when the existing sub's key provably differs from `wantKey`. */
function keyChanged(sub: PushSubscription, wantKey: Uint8Array): boolean {
  const existing = sub.options?.applicationServerKey;
  // Some browsers don't expose options.applicationServerKey — can't tell, so
  // assume unchanged rather than churn a working subscription.
  if (!existing) return false;
  const have = new Uint8Array(existing as ArrayBuffer);
  if (have.length !== wantKey.length) return true;
  for (let i = 0; i < have.length; i++) {
    if (have[i] !== wantKey[i]) return true;
  }
  return false;
}

async function subscribePush(): Promise<PushSubscription | null> {
  const publicKey = await getVapidKey();
  if (!publicKey) return null;
  const wantKey = urlBase64ToUint8Array(publicKey);

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  // A subscription created against a now-rotated VAPID key can never receive
  // pushes — drop it and re-subscribe with the current key.
  if (subscription && keyChanged(subscription, wantKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wantKey,
    } as PushSubscriptionOptionsInit);
  }

  return subscription;
}

export async function initializeMessaging(): Promise<boolean> {
  if (!isNotificationSupported()) return false;
  try {
    await navigator.serviceWorker.register(SW_PATH);
    return true;
  } catch (err) {
    console.warn("Failed to register push service worker:", err);
    return false;
  }
}

/**
 * Subscribe the browser to push (creating the PushSubscription if needed) and
 * upsert the resulting endpoint into the backend `push_subscriptions` row.
 * The `/push/subscribe` route upserts by endpoint, so this is idempotent —
 * calling it when already registered is harmless. Returns the server's ok.
 */
async function registerSubscription(): Promise<boolean> {
  const subscription = await subscribePush();
  if (!subscription) return false;

  const subJson = subscription.toJSON();
  const res = await fetch(`${getApiBase()}/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: subJson.keys,
    }),
  });

  return res.ok;
}

export async function requestNotificationPermission(userId: string): Promise<boolean> {
  void userId; // subscription is tied to auth token, not userId directly
  if (!isNotificationSupported()) return false;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    return registerSubscription();
  } catch (err) {
    console.error("Failed to enable push notifications:", err);
    return false;
  }
}

/**
 * Heal/reconcile path: keep the backend `push_subscriptions` row in sync with
 * the browser's subscription WITHOUT ever prompting the user. This fixes the
 * "permission granted but the server pruned the subscription (FCM 404/410/403)
 * → UI wrongly shows enabled, nothing re-subscribes" gap: the upsert re-creates
 * a server-pruned row from the still-valid browser subscription (or creates a
 * fresh subscription if the browser's was cleared). Returns whether a live,
 * server-acknowledged subscription now exists.
 *
 * Only reconciles when permission is already "granted" — never prompts.
 */
export async function reconcilePushSubscription(): Promise<boolean> {
  if (!isNotificationSupported()) return false;
  if (Notification.permission !== "granted") return false;

  try {
    return await registerSubscription();
  } catch (err) {
    console.error("Failed to reconcile push subscription:", err);
    return false;
  }
}

export async function disableNotifications(userId: string): Promise<void> {
  void userId;
  if (!isNotificationSupported()) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      const endpoint = subscription.endpoint;

      // Unsubscribe locally
      await subscription.unsubscribe();

      // Remove from server
      await fetch(`${getApiBase()}/push/unsubscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ endpoint }),
      });
    }
  } catch (err) {
    console.error("Failed to disable push notifications:", err);
  }
}

export function onForegroundMessage(_callback: (payload: unknown) => void): (() => void) | null {
  // Push events arrive at the service worker. For foreground handling,
  // we listen for messages posted from the service worker.
  if (!isNotificationSupported()) return null;

  const handler = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object") {
      _callback(event.data);
    }
  };

  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}

export interface ServiceWorkerMessage {
  type: string;
  questionId?: string;
  value?: number;
}

export function listenForServiceWorkerMessages(callback: (data: ServiceWorkerMessage) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};

  const handler = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object" && event.data.type) {
      callback(event.data as ServiceWorkerMessage);
    }
  };

  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}

export function getNotificationPermissionStatus(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}
