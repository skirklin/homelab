/**
 * Push notification stubs.
 * FCM is not available with PocketBase. These are no-op stubs
 * so the rest of the app compiles without changes.
 */

export async function initializeMessaging(): Promise<boolean> {
  console.log("push notifications not yet migrated");
  return false;
}

export async function requestNotificationPermission(_userId: string): Promise<boolean> {
  console.log("push notifications not yet migrated");
  return false;
}

export async function disableNotifications(_userId: string): Promise<void> {
  console.log("push notifications not yet migrated");
}

export function onForegroundMessage(_callback: (payload: unknown) => void): (() => void) | null {
  console.log("push notifications not yet migrated");
  return null;
}

export interface ServiceWorkerMessage {
  type: string;
  questionId?: string;
  value?: number;
}

export function listenForServiceWorkerMessages(_callback: (data: ServiceWorkerMessage) => void): () => void {
  console.log("push notifications not yet migrated");
  return () => {};
}

export function getNotificationPermissionStatus(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}
