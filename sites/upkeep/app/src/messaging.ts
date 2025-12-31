import { getMessaging, getToken, onMessage, type Messaging } from "firebase/messaging";
import { app } from "./backend";
import { saveFcmToken } from "./firestore";

let messaging: Messaging | null = null;

// VAPID key for web push - you'll need to generate this in Firebase Console
// Go to: Project Settings > Cloud Messaging > Web Push certificates
const VAPID_KEY = "BCd5kDyxZ_F5NCGM60m35hjUYnXqUL53fPCZPk7V2O2KZ3DfiNFsy0NGVqe1oYNSGOIos5wLLFh1qpBC4TGGFEY"

export function isNotificationSupported(): boolean {
  return "Notification" in window && "serviceWorker" in navigator;
}

export async function initializeMessaging(): Promise<Messaging | null> {
  if (!isNotificationSupported()) {
    console.log("Notifications not supported in this browser");
    return null;
  }

  try {
    messaging = getMessaging(app);
    return messaging;
  } catch (error) {
    console.error("Failed to initialize messaging:", error);
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) {
    return "denied";
  }

  const permission = await Notification.requestPermission();
  return permission;
}

export async function getFcmToken(userId: string): Promise<string | null> {
  if (!messaging) {
    messaging = await initializeMessaging();
  }

  if (!messaging) {
    return null;
  }

  try {
    // Register service worker and wait for it to be ready
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

    // Wait for the service worker to be active
    if (registration.installing) {
      await new Promise<void>((resolve) => {
        registration.installing!.addEventListener("statechange", function handler() {
          if (this.state === "activated") {
            this.removeEventListener("statechange", handler);
            resolve();
          }
        });
      });
    } else if (registration.waiting) {
      await new Promise<void>((resolve) => {
        registration.waiting!.addEventListener("statechange", function handler() {
          if (this.state === "activated") {
            this.removeEventListener("statechange", handler);
            resolve();
          }
        });
      });
    }
    // If already active, no need to wait

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (token) {
      // Save token to Firestore
      await saveFcmToken(userId, token);
      console.log("FCM token saved:", token.substring(0, 20) + "...");
      return token;
    } else {
      console.log("No FCM token available");
      return null;
    }
  } catch (error) {
    console.error("Failed to get FCM token:", error);
    return null;
  }
}

export function onForegroundMessage(callback: (payload: unknown) => void): void {
  if (!messaging) {
    console.warn("Messaging not initialized");
    return;
  }

  onMessage(messaging, (payload) => {
    console.log("Foreground message received:", payload);
    callback(payload);
  });
}
