/**
 * Notification trigger endpoints — internal, API-key-only.
 *
 * These are now PRIMARILY driven by the in-process scheduler in
 * ../lib/notifications/scheduler.ts, which calls the same lib functions
 * directly (no HTTP hop). The endpoints are kept for manual triggering and for
 * the test suite; the k8s CronJobs that used to curl them have been removed.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { runUpkeepNotifications } from "../lib/notifications/upkeep";
import { runDeadlineNotifications } from "../lib/notifications/deadlines";
import { runLifeTrackerSampling, runLifeReminderCheck } from "../lib/notifications/life";
import { runTravelNotificationsTick } from "../lib/notifications/travel";

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.post("/upkeep-check", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runUpkeepNotifications();
  const deadlines = await runDeadlineNotifications();
  return c.json({ status: "ok", ...result, deadlines });
}));

notificationRoutes.post("/life-sample-check", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runLifeTrackerSampling();
  return c.json({ status: "ok", ...result });
}));

notificationRoutes.post("/life-reminders-check", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runLifeReminderCheck();
  return c.json({ status: "ok", ...result });
}));

notificationRoutes.post("/travel-tick", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runTravelNotificationsTick();
  return c.json({ status: "ok", ...result });
}));
