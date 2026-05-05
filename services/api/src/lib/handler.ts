/**
 * Wraps a route handler with consistent error handling, logging, and
 * transparent retry on transient SQLite busy/locked errors.
 */
import type { Context } from "hono";
import type { AppEnv } from "../index";
import { retryOnBusy } from "./retry";

type HandlerContext = Context<AppEnv>;

export function handler(
  fn: (c: HandlerContext) => Promise<Response>,
): (c: HandlerContext) => Promise<Response> {
  return async (c) => {
    try {
      // Retry the entire handler on SQLite busy/locked errors. Safe because
      // write operations are idempotent enough (create-before-check patterns
      // would throw 400s, which are not retried).
      return await retryOnBusy(() => fn(c));
    } catch (err) {
      console.error(`${c.req.method} ${c.req.path}:`, err);
      // PocketBase's ClientResponseError carries upstream status (e.g. 404
      // for missing record). Forward any 4xx as-is so callers see the right
      // shape; everything else collapses to 500.
      const upstream = (err as { status?: unknown })?.status;
      const status = typeof upstream === "number" && upstream >= 400 && upstream < 500
        ? (upstream as 400 | 401 | 403 | 404)
        : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        status,
      );
    }
  };
}
