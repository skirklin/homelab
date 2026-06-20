/**
 * Push notification routes — Web Push (VAPID) subscription management and sending.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { sendPushToUser } from "../lib/push";

export const pushRoutes = new Hono<AppEnv>();

// GET /push/vapid-key is handled in index.ts (before auth middleware)

/**
 * POST /push/subscribe — save a push subscription for the authenticated user.
 * Body: { endpoint: string, keys: { p256dh: string, auth: string } }
 */
pushRoutes.post("/subscribe", handler(async (c) => {
  const userId = c.get("userId");
  const pb = c.get("pb");
  const origin = c.req.header("Origin") || "";
  const { endpoint, keys } = await c.req.json<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }>();

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: "Invalid subscription: endpoint and keys (p256dh, auth) required" }, 400);
  }

  // Check if this endpoint already exists for this user
  const existing = await pb.collection("push_subscriptions").getList(1, 1, {
    filter: pb.filter("user = {:userId} && endpoint = {:endpoint}", { userId, endpoint }),
    $autoCancel: false,
  });

  if (existing.items.length > 0) {
    // Update existing subscription (keys may have rotated)
    await pb.collection("push_subscriptions").update(existing.items[0].id, {
      keys,
      origin,
    }, { $autoCancel: false });
    return c.json({ status: "updated", id: existing.items[0].id });
  }

  // Create new subscription
  const record = await pb.collection("push_subscriptions").create({
    user: userId,
    endpoint,
    keys,
    origin,
  }, { $autoCancel: false });

  return c.json({ status: "created", id: record.id });
}));

/**
 * POST /push/unsubscribe — remove a push subscription.
 * Body: { endpoint: string }
 */
pushRoutes.post("/unsubscribe", handler(async (c) => {
  const userId = c.get("userId");
  const pb = c.get("pb");
  const { endpoint } = await c.req.json<{ endpoint: string }>();

  if (!endpoint) {
    return c.json({ error: "endpoint is required" }, 400);
  }

  const existing = await pb.collection("push_subscriptions").getList(1, 1, {
    filter: pb.filter("user = {:userId} && endpoint = {:endpoint}", { userId, endpoint }),
    $autoCancel: false,
  });

  if (existing.items.length > 0) {
    await pb.collection("push_subscriptions").delete(existing.items[0].id, {
      $autoCancel: false,
    });
  }

  return c.json({ status: "removed" });
}));

/**
 * POST /push/send — send a push notification to a user.
 * Body: { userId: string, title: string, body: string, url?: string, data?: object }
 *
 * This is an internal endpoint — intended to be called by PocketBase hooks
 * or scheduled tasks, not directly by frontends.
 *
 * INTENTIONALLY does NOT pass `preferredOrigins` (so it reaches ALL of the
 * user's subscriptions, every device) and does NOT route through the
 * `notification_log` ledger (no per-day dedup). That's correct for its only
 * caller — the event-watcher infra-alert path (a separate process; see
 * services/event-watcher/src/index.ts). Those alerts are duration-gated upstream
 * (so they don't spam), carry an absolute monitor URL, and should buzz every
 * device the operator owns; per-day collapsing or single-origin delivery would
 * defeat the point. It inherits `sendPushToUser`'s defaults — `urgency:"high"` +
 * a 4h TTL — for prompt delivery.
 */
pushRoutes.post("/send", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "This endpoint requires API key authentication" }, 403);
  }

  const pb = c.get("pb");
  const { userId, title, body, url, data } = await c.req.json<{
    userId: string;
    title: string;
    body?: string;
    url?: string;
    data?: Record<string, unknown>;
  }>();

  if (!userId || !title) {
    return c.json({ error: "userId and title are required" }, 400);
  }

  const result = await sendPushToUser(pb, userId, { title, body, url, data });

  if (result.sent === 0 && result.expired === 0 && result.failed === 0) {
    return c.json({ status: "no_subscriptions", sent: 0 });
  }

  return c.json({ status: "ok", ...result });
}));
