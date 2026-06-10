/**
 * Observer route — generates AI observations from life-tracker data.
 *
 * POST /observer/generate
 *   Body: { period, window_start, window_end }
 *   Returns the created claude_observations record as JSON.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { runObserverGeneration, VALID_PERIODS, type ObserverPeriod } from "../lib/observer/generate";

export const observerRoutes = new Hono<AppEnv>();

observerRoutes.post("/generate", handler(async (c) => {
  const body = await c.req.json<{
    period?: string;
    window_start?: string;
    window_end?: string;
  }>();

  // --- Validation ---
  if (!body.period || !body.window_start || !body.window_end) {
    return c.json(
      { error: "Missing required fields: period, window_start, window_end" },
      400,
    );
  }

  if (!VALID_PERIODS.includes(body.period as ObserverPeriod)) {
    return c.json(
      { error: `Invalid period: must be one of ${VALID_PERIODS.join(", ")}` },
      400,
    );
  }

  const windowStart = new Date(body.window_start);
  const windowEnd = new Date(body.window_end);

  if (isNaN(windowStart.getTime())) {
    return c.json({ error: "Invalid window_start: must be a valid ISO date" }, 400);
  }
  if (isNaN(windowEnd.getTime())) {
    return c.json({ error: "Invalid window_end: must be a valid ISO date" }, 400);
  }
  if (windowEnd <= windowStart) {
    return c.json({ error: "window_end must be after window_start" }, 400);
  }

  const period = body.period as ObserverPeriod;
  const pb = c.get("pb");
  // authMiddleware's userClient(token) calls pb.authStore.save(token, null) —
  // the record is null for PB JWT callers (every frontend request). Always
  // read the resolved caller id from c.get("userId") instead. Matches
  // chat.ts / sharing.ts / push.ts / data.ts.
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const result = await runObserverGeneration({
    pb,
    ownerId: userId,
    period,
    windowStart,
    windowEnd,
  });

  return c.json(result);
}));
