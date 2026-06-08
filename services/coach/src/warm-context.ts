/**
 * Warm-context — give a fresh Coach session a snapshot of recent life data
 * so the agent isn't reading blind on the first turn.
 *
 * Reuses the observer bundle module to keep the data shape consistent
 * between the Sunday-cron observation and the realtime coach. (One
 * "current state of Scott" representation, not two.) The import path
 * reaches across the services/ tree — the production Docker image copies
 * the two source files in via `infra/docker/coach.Dockerfile` so the
 * relative `import` resolves at runtime.
 *
 * SDK shape note: the SDK has no first-class "additional context" option
 * for `query()` — `systemPrompt` is reserved for the assistant's
 * instructions and `additionalDirectories`/`hooks` are about runtime
 * powers, not seed text. The cleanest path is to yield a synthetic user
 * message as the first stream entry, clearly labeled as system-injected
 * context. The agent's anti-restate-the-data rule makes it unlikely to
 * parrot the bundle back; if it does, that's a prompt-iteration job, not
 * a wiring job.
 */
import type PocketBase from "pocketbase";

// Bundle module lives in the api service; copied into the coach image at
// build time. Path is relative to this file under /workspace/services/coach/src.
// eslint-disable-next-line import/no-relative-parent-imports
import { assembleBundle } from "../../api/src/lib/observer/bundle.js";

const DEFAULT_WINDOW_DAYS = 14;

export interface WarmContextDeps {
  pb: PocketBase;
  /** PB user id the session belongs to. Passed through to `assembleBundle` so the bundle can owner-filter its fetches when called with admin auth. */
  ownerId: string;
  /** Optional override for the lookback window. Defaults to 14 days. */
  windowDays?: number;
  /** Optional user IANA timezone for bundle day-keys. */
  timezone?: string;
}

/**
 * Build the synthetic warm-context user message. Wraps the bundle markdown
 * in a clear `[System context — ...]` header so the agent can see this
 * isn't conversational input.
 *
 * Whether to call this on a given message is the agent manager's decision
 * (per-pod `primedThisPod` set, see agent.ts). The old PB-backed
 * `ownerHasPriorSessions` probe was misleading: it returned true for any
 * user with prior coach_sessions rows, which after a pod restart would
 * SKIP warm-context — but the SDK session was also fresh, so the agent
 * read blind. The per-pod set tracks the SDK session's actual lifetime.
 */
export async function buildWarmContextMessage(
  deps: WarmContextDeps,
): Promise<string | null> {
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  let bundleMarkdown: string;
  try {
    const result = await assembleBundle({
      pb: deps.pb,
      // Admin PB is used by the coach; tell the bundle to filter on owner
      // so a future second user can't see Scott's data through the
      // warm-context path. Single-tenant moot today; tenancy-correct now.
      ownerId: deps.ownerId,
      windowStart,
      windowEnd,
      timezone: deps.timezone,
    });
    bundleMarkdown = result.markdown;
  } catch (e) {
    console.error(
      `[coach] warm-context bundle assembly failed for ${deps.ownerId}; skipping:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }

  return [
    "[System context — generated at session start, not from the user.",
    "Scott didn't type this. It's a snapshot of his recent life-tracker data",
    `for the past ${windowDays} days, so you have a baseline before the`,
    "actual conversation begins. Do not reply to this message; the real",
    "first user turn comes next.]",
    "",
    bundleMarkdown,
  ].join("\n");
}
