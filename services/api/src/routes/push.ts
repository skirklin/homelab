/**
 * Push notification routes — Web Push (VAPID) subscription management and sending.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import webpush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:scott.kirklin@gmail.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export const pushRoutes = new Hono<AppEnv>();

/**
 * GET /push/vapid-key — return the public VAPID key so frontends can subscribe.
 * No auth required for this endpoint (handled at mount level).
 */
pushRoutes.get("/vapid-key", (c) => {
  if (!VAPID_PUBLIC_KEY) {
    return c.json({ error: "VAPID keys not configured" }, 503);
  }
  return c.json({ publicKey: VAPID_PUBLIC_KEY });
});

/**
 * POST /push/subscribe — save a push subscription for the authenticated user.
 * Body: { endpoint: string, keys: { p256dh: string, auth: string } }
 */
pushRoutes.post("/subscribe", handler(async (c) => {
  const userId = c.get("userId");
  const pb = c.get("pb");
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
    }, { $autoCancel: false });
    return c.json({ status: "updated", id: existing.items[0].id });
  }

  // Create new subscription
  const record = await pb.collection("push_subscriptions").create({
    user: userId,
    endpoint,
    keys,
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
 */
pushRoutes.post("/send", handler(async (c) => {
  // Only allow API key auth — this is an internal endpoint for PocketBase hooks/tasks
  if (!c.get("isApiKey")) {
    return c.json({ error: "This endpoint requires API key authentication" }, 403);
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return c.json({ error: "VAPID keys not configured" }, 503);
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

  // Get all subscriptions for the target user
  const subs = await pb.collection("push_subscriptions").getFullList({
    filter: pb.filter("user = {:userId}", { userId }),
    $autoCancel: false,
  });

  if (subs.length === 0) {
    return c.json({ status: "no_subscriptions", sent: 0 });
  }

  const payload = JSON.stringify({ title, body, url, ...data });
  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint as string,
        keys: sub.keys as { p256dh: string; auth: string },
      };
      try {
        await webpush.sendNotification(subscription, payload);
        return { id: sub.id, status: "sent" as const };
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404 or 410 means the subscription is no longer valid — clean it up
        if (statusCode === 404 || statusCode === 410) {
          await pb.collection("push_subscriptions").delete(sub.id, {
            $autoCancel: false,
          }).catch(() => {});
          return { id: sub.id, status: "expired" as const };
        }
        throw err;
      }
    })
  );

  const sent = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "sent"
  ).length;
  const expired = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "expired"
  ).length;
  const failed = results.filter((r) => r.status === "rejected").length;

  return c.json({ status: "ok", sent, expired, failed });
}));
