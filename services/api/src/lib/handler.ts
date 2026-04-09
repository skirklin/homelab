/**
 * Wraps a route handler with consistent error handling and logging.
 */
import type { Context } from "hono";
import type { AppEnv } from "../index";

type HandlerContext = Context<AppEnv>;

export function handler(
  fn: (c: HandlerContext) => Promise<Response>,
): (c: HandlerContext) => Promise<Response> {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      console.error(`${c.req.method} ${c.req.path}:`, err);
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      );
    }
  };
}
