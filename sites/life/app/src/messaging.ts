import { getMessaging, getToken, onMessage, type Messaging } from "firebase/messaging";
import { getBackend } from "@kirkl/shared";
import { saveFcmToken, removeFcmToken } from "./firestore";

let messaging: Messaging | null = null;

// VAPID key for web push
// You can get this from Firebase Console > Project Settings > Cloud Messaging
const VAPID_KEY = "BCd5kDyxZ_F5NCGM60m35hjUYnXqUL53fPCZPk7V2O2KZ3DfiNFsy0NGVqe1oYNSGOIos5wLLFh1qpBC4TGGFEY";

export async function initializeMessaging(): Promise<boolean> {
  if (!("Notification" in window)) {
    console.log("This browser does not support notifications");
    return false;
  }

  if (!("serviceWorker" in navigator)) {
    console.log("This browser does not support service workers");
    return false;
  }

  try {
    const { app } = getBackend();
    messaging = getMessaging(app);
    return true;
  } catch (error) {
    console.error("Failed to initialize messaging:", error);
    return false;
  }
}

export async function requestNotificationPermission(userId: string): Promise<boolean> {
  if (!messaging) {
    const initialized = await initializeMessaging();
    if (!initialized) return false;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.log("Notification permission denied");
      return false;
    }

    // Register service worker
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    console.log("Service worker registered:", registration);

    // Get FCM token
    const token = await getToken(messaging!, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (token) {
      console.log("FCM token:", token);
      await saveFcmToken(userId, token);
      return true;
    }

    console.log("No FCM token available");
    return false;
  } catch (error) {
    console.error("Failed to get notification permission:", error);
    return false;
  }
}

export async function disableNotifications(userId: string): Promise<void> {
  try {
    await removeFcmToken(userId);
  } catch (error) {
    console.error("Failed to remove FCM token:", error);
  }
}

export function onForegroundMessage(callback: (payload: unknown) => void): (() => void) | null {
  if (!messaging) return null;

  return onMessage(messaging, (payload) => {
    console.log("Foreground message received:", payload);
    callback(payload);
  });
}

export function listenForServiceWorkerMessages(callback: (data: { type: string }) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (event.data && event.data.type) {
      callback(event.data);
    }
  };

  navigator.serviceWorker.addEventListener("message", handler);

  return () => {
    navigator.serviceWorker.removeEventListener("message", handler);
  };
}

export function getNotificationPermissionStatus(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}
