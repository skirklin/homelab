/**
 * Web Push notification support for the Life Tracker app.
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

function isNotificationSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

async function subscribePush(): Promise<PushSubscription | null> {
  const publicKey = await getVapidKey();
  if (!publicKey) return null;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
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

export async function requestNotificationPermission(userId: string): Promise<boolean> {
  void userId; // subscription is tied to auth token, not userId directly
  if (!isNotificationSupported()) return false;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const subscription = await subscribePush();
    if (!subscription) return false;

    const subJson = subscription.toJSON();
    const res = await fetch(`${getApiUrl()}/push/subscribe`, {
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

    return res.ok;
  } catch (err) {
    console.error("Failed to enable push notifications:", err);
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
      await fetch(`${getApiUrl()}/push/unsubscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAuthToken()}`,
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
