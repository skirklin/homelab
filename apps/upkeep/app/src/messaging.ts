/**
 * Web Push notification support for the Upkeep app.
 * Uses the standard Push API with VAPID keys (replaces FCM).
 */

import { getBackend } from "@kirkl/shared";

// vite-plugin-pwa generates the SW at /sw.js and importScripts() the
// existing /push-sw.js push handler into it (see vite.config.ts).
const SW_PATH = "/sw.js";
const API_BASE = import.meta.env.VITE_API_URL as string | undefined;

function getApiUrl(): string {
  return API_BASE || "https://api.beta.kirkl.in";
}

function getAuthToken(): string {
  return getBackend().authStore.token;
}

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
    const res = await fetch(`${getApiUrl()}/push/vapid-key`);
    if (!res.ok) return null;
    const data = await res.json() as { publicKey: string };
    vapidPublicKey = data.publicKey;
    return vapidPublicKey;
  } catch {
    return null;
  }
}

export function isNotificationSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export async function initializeMessaging(): Promise<null> {
  if (!isNotificationSupported()) return null;
  try {
    await navigator.serviceWorker.register(SW_PATH);
  } catch (err) {
    console.warn("Failed to register push service worker:", err);
  }
  return null;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return "denied";
  return Notification.requestPermission();
}

/**
 * Get (or create) a push subscription and register it with the API.
 * Returns the subscription endpoint as a token string, or null on failure.
 */
export async function getFcmToken(userId: string): Promise<string | null> {
  void userId; // kept for API compatibility; subscription is tied to auth token
  if (!isNotificationSupported()) return null;

  try {
    const publicKey = await getVapidKey();
    if (!publicKey) {
      console.warn("VAPID public key not available");
      return null;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      } as PushSubscriptionOptionsInit);
    }

    if (!subscription) return null;

    // Send subscription to API
    const subJson = subscription.toJSON();
    await fetch(`${getApiUrl()}/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      }),
    });

    return subJson.endpoint ?? null;
  } catch (err) {
    console.error("Failed to get push subscription:", err);
    return null;
  }
}

export function onForegroundMessage(_callback: (payload: unknown) => void): void {
  // Foreground push events are handled by the service worker.
  // The app can listen for service worker messages if needed.
}
