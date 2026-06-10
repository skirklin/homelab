/**
 * Observer generation — shared by the HTTP route (POST /observer/generate)
 * and the in-process weekly scheduler (scheduler.ts).
 *
 * Assembles the life-data bundle for [windowStart, windowEnd), asks Claude for
 * 2-3 observations + a question, and persists a claude_observations record
 * owned by `ownerId`.
 *
 * NOTE on scoping: when called with an ADMIN pb (the scheduler), `ownerId` MUST
 * be passed so assembleBundle filters to that owner's data — an admin client
 * sees every user's rows, so omitting it would blend all users together. The
 * HTTP route passes a user-scoped pb and lets PB access rules do the filtering,
 * so it can leave ownerId unset there. Either way the created record's `owner`
 * is set explicitly to `ownerId`.
 *
 * NOT idempotent: every call performs one Anthropic request and creates one
 * record. Callers that retry will produce duplicate observations — the
 * scheduler therefore does NOT do startup catch-up for this job.
 */
import type PocketBase from "pocketbase";
import { getAnthropicClient, extractText, CLAUDE_MODEL } from "../ai";
import { assembleBundle } from "./bundle";
import { OBSERVER_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt";

export const VALID_PERIODS = ["weekly", "monthly", "adhoc"] as const;
export type ObserverPeriod = (typeof VALID_PERIODS)[number];

export interface ObserverResult {
  id: string;
  content: string;
  period: ObserverPeriod;
  data_window_start: string;
  data_window_end: string;
  related_event_ids: string[];
  prompt_version: string;
  created: string;
}

export async function runObserverGeneration(opts: {
  pb: PocketBase;
  ownerId: string;
  period: ObserverPeriod;
  windowStart: Date;
  windowEnd: Date;
}): Promise<ObserverResult> {
  const { pb, ownerId, period, windowStart, windowEnd } = opts;

  const { markdown, relatedEventIds } = await assembleBundle({
    pb,
    ownerId,
    windowStart,
    windowEnd,
  });

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: OBSERVER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: markdown }],
  });

  const content = extractText(response);

  const record = await pb.collection("claude_observations").create({
    content,
    period,
    data_window_start: windowStart.toISOString(),
    data_window_end: windowEnd.toISOString(),
    related_event_ids: relatedEventIds,
    owner: ownerId,
    prompt_version: PROMPT_VERSION,
  });

  return {
    id: record.id,
    content,
    period,
    data_window_start: windowStart.toISOString(),
    data_window_end: windowEnd.toISOString(),
    related_event_ids: relatedEventIds,
    prompt_version: PROMPT_VERSION,
    created: record.created,
  };
}
