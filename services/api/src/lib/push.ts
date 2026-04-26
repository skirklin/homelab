/**
 * Shared push notification sending utility.
 * Used by both the /push/send HTTP endpoint and the notification triggers.
 */
import type PocketBase from "pocketbase";
import webpush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:scott.kirklin@gmail.com";

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys not configured");
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  data?: Record<string, unknown>;
}

export interface PushResult {
  sent: number;
  expired: number;
  failed: number;
}

export interface SendOptions {
  /**
   * Origins (e.g. "https://upkeep.kirkl.in") in priority order. Each user
   * may have subscriptions from multiple origins of the same logical app
   * (e.g. upkeep.kirkl.in vs kirkl.in/upkeep). To avoid delivering the
   * notification twice on one device, we send only to subs from the
   * first origin in this list that has any matches; if none match, we
   * fall back to legacy subs with no recorded origin.
   */
  preferredOrigins?: string[];
}

/**
 * Send a push notification to a user's subscriptions.
 * Picks one origin per user via `preferredOrigins` to avoid duplicate
 * notifications when the same app is reachable at multiple URLs.
 * Automatically cleans up expired subscriptions.
 */
export async function sendPushToUser(
  pb: PocketBase,
  userId: string,
  payload: PushPayload,
  options: SendOptions = {},
): Promise<PushResult> {
  ensureVapid();

  const allSubs = await pb.collection("push_subscriptions").getFullList({
    filter: pb.filter("user = {:userId}", { userId }),
    $autoCancel: false,
  });

  if (allSubs.length === 0) {
    return { sent: 0, expired: 0, failed: 0 };
  }

  // Pick a single origin's subs. Walk preferredOrigins in priority order;
  // first origin with any matches wins. Fall back to legacy subs (no origin
  // recorded) only if no preferred origin matched.
  let subs = allSubs;
  const preferred = options.preferredOrigins;
  if (preferred && preferred.length > 0) {
    let chosen: typeof allSubs | null = null;
    for (const origin of preferred) {
      const matches = allSubs.filter((s) => (s.origin || "") === origin);
      if (matches.length > 0) {
        chosen = matches;
        break;
      }
    }
    if (!chosen) {
      const legacy = allSubs.filter((s) => !s.origin);
      chosen = legacy.length > 0 ? legacy : [];
    }
    subs = chosen;
  }

  if (subs.length === 0) {
    return { sent: 0, expired: 0, failed: 0 };
  }

  const body = JSON.stringify({ ...payload.data, title: payload.title, body: payload.body, url: payload.url });

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint as string,
        keys: sub.keys as { p256dh: string; auth: string },
      };
      try {
        await webpush.sendNotification(subscription, body);
        return "sent" as const;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pb.collection("push_subscriptions").delete(sub.id, {
            $autoCancel: false,
          }).catch(() => {});
          return "expired" as const;
        }
        throw err;
      }
    }),
  );

  return {
    sent: results.filter(r => r.status === "fulfilled" && r.value === "sent").length,
    expired: results.filter(r => r.status === "fulfilled" && r.value === "expired").length,
    failed: results.filter(r => r.status === "rejected").length,
  };
}
