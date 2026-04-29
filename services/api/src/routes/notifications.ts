/**
 * Notification trigger endpoints — internal, API-key-only.
 * Called by k8s CronJobs or manually for testing.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { runUpkeepNotifications } from "../lib/notifications/upkeep";
import { runLifeTrackerSampling } from "../lib/notifications/life";
import {
  runTravelMorningNotifications,
  runTravelEveningNotifications,
} from "../lib/notifications/travel";

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.post("/upkeep-check", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runUpkeepNotifications();
  return c.json({ status: "ok", ...result });
}));

notificationRoutes.post("/life-sample-check", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runLifeTrackerSampling();
  return c.json({ status: "ok", ...result });
}));

notificationRoutes.post("/travel-morning", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runTravelMorningNotifications();
  return c.json({ status: "ok", ...result });
}));

notificationRoutes.post("/travel-evening", handler(async (c) => {
  if (!c.get("isApiKey")) {
    return c.json({ error: "Requires API key authentication" }, 403);
  }
  const result = await runTravelEveningNotifications();
  return c.json({ status: "ok", ...result });
}));
