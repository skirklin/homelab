/**
 * Messaging stub — FCM push notifications are not yet migrated to PocketBase.
 * All exports are no-ops that log a message.
 */

export function isNotificationSupported(): boolean {
  console.log("push notifications not yet migrated");
  return false;
}

export async function initializeMessaging(): Promise<null> {
  console.log("push notifications not yet migrated");
  return null;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  console.log("push notifications not yet migrated");
  return "denied";
}

export async function getFcmToken(_userId: string): Promise<string | null> {
  console.log("push notifications not yet migrated");
  return null;
}

export function onForegroundMessage(_callback: (payload: unknown) => void): void {
  console.log("push notifications not yet migrated");
}
