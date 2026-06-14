import type { Context } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";

/**
 * TEMPORARY Phase-1 capture endpoint for the Health Connect phone companion app.
 *
 * Served at POST /fn/health/ingest (the reverse proxy strips /fn). Behind the
 * global authMiddleware, so the caller's hlk_ / mcpat_ / PB token identifies
 * which user the data belongs to via c.get("userId"). It does NOT write to
 * PocketBase or life_events — Phase 1 is observation only: log the raw payload
 * (so the real shape can be read off `kubectl logs`) and echo a per-array count
 * summary back to the companion app's webhook log.
 *
 * TODO: remove after Phase-1 schema verification (replaced by the real mapper).
 */
export const ingestCaptureHandler = handler(async (c: Context<AppEnv>) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "expected a JSON object body" }, 400);
  }

  // PII-in-logs is acceptable here — personal homelab, temporary capture stub.
  // TODO: remove after Phase-1 schema verification.
  console.log(`[health-ingest-capture] user=${userId} ${JSON.stringify(body)}`);

  // Count every top-level array so the companion app's webhook log shows what
  // arrived without us hardcoding the (still-unconfirmed) set of data types.
  const received: Record<string, number> = {};
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) received[key] = value.length;
  }

  return c.json({
    ok: true,
    user: userId,
    received,
    payload_keys: Object.keys(body),
  });
});
