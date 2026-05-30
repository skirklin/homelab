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
import { getAnthropicClient, extractText, CLAUDE_MODEL } from "../lib/ai";
import { assembleBundle } from "../lib/observer/bundle";
import { OBSERVER_SYSTEM_PROMPT, PROMPT_VERSION } from "../lib/observer/prompt";

export const observerRoutes = new Hono<AppEnv>();

const VALID_PERIODS = ["weekly", "monthly", "adhoc"] as const;
type Period = (typeof VALID_PERIODS)[number];

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

  if (!VALID_PERIODS.includes(body.period as Period)) {
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

  const period = body.period as Period;
  const pb = c.get("pb");
  // authMiddleware's userClient(token) calls pb.authStore.save(token, null) —
  // the record is null for PB JWT callers (every frontend request). Always
  // read the resolved caller id from c.get("userId") instead. Matches
  // chat.ts / sharing.ts / push.ts / data.ts.
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  // --- Bundle assembly ---
  const { markdown, relatedEventIds } = await assembleBundle({
    pb,
    windowStart,
    windowEnd,
  });

  // --- Anthropic API call ---
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: OBSERVER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: markdown }],
  });

  const content = extractText(response);

  // --- Persist to PocketBase ---
  const record = await pb.collection("claude_observations").create({
    content,
    period,
    data_window_start: windowStart.toISOString(),
    data_window_end: windowEnd.toISOString(),
    related_event_ids: relatedEventIds,
    owner: userId,
    prompt_version: PROMPT_VERSION,
  });

  return c.json({
    id: record.id,
    content,
    period,
    data_window_start: windowStart.toISOString(),
    data_window_end: windowEnd.toISOString(),
    related_event_ids: relatedEventIds,
    prompt_version: PROMPT_VERSION,
    created: record.created,
  });
}));
