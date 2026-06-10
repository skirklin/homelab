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
  /**
   * Static deep-link URL. Prefer a SAME-ORIGIN RELATIVE path (e.g. `/travel/x`)
   * over an absolute URL: PocketBase auth is per-origin localStorage, so an
   * absolute cross-origin URL cold-loads an origin whose session is empty and
   * presents as a forced sign-out. For apps reachable at multiple origins, use
   * `buildUrl` instead so the path matches the delivery origin.
   */
  url?: string;
  /**
   * Origin-aware deep link. Invoked with the origin actually chosen for
   * delivery (see `SendOptions.preferredOrigins`); its return value overrides
   * `url`. Return a same-origin relative path correct for that origin —
   * e.g. `/travel/{id}` for the embedded `kirkl.in` origin vs `/{id}` for the
   * standalone `travel.kirkl.in` origin. Legacy subs with no recorded origin
   * receive `""`.
   */
  buildUrl?: (origin: string) => string;
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

  // All chosen subs share one origin (or are legacy with none). Resolve the
  // deep link against THAT origin so the click stays where the user is signed
  // in. `buildUrl` wins over a static `url` when provided.
  const deliveryOrigin = (subs[0]?.origin as string) || "";
  const url = payload.buildUrl ? payload.buildUrl(deliveryOrigin) : payload.url;

  const body = JSON.stringify({ ...payload.data, title: payload.title, body: payload.body, url });

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
        // 403 means VAPID auth failed for THIS subscription: it was created
        // against a different applicationServerKey (e.g. before a VAPID key
        // rotation) and can never receive pushes again, so prune it just like
        // an expired (404/410) sub. This is safe because a misconfigured
        // server key would fail ALL sends uniformly — a 403 on only a subset
        // means those specific subs are stale, not that the server is broken.
        if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
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
