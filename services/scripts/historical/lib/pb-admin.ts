/**
 * Shared PocketBase plumbing for the one-shot life history rewrite scripts
 * (merge-sleep-quality.ts / split-category-subjects.ts /
 *  fanout-session-events.ts).
 *
 * Auth follows the recover-life-events.ts convention: superuser creds come
 * from the repo-root .env (`export $(grep -v '^#' .env | xargs)` before
 * running), PB URL defaults to production api.kirkl.in and can be overridden
 * with --pb-url / PB_URL for test-PB smoke runs.
 */
import PocketBase from "pocketbase";
import { type Entry, type EventRow, safeTz } from "./life-rewrite";

export async function connectAdmin(pbUrl: string): Promise<PocketBase> {
  const email = process.env.PB_ADMIN_EMAIL || "scott.kirklin@gmail.com";
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!password) {
    console.error("PB_ADMIN_PASSWORD not set (export $(grep -v '^#' .env | xargs))");
    process.exit(1);
  }
  const pb = new PocketBase(pbUrl);
  pb.autoCancellation(false);
  try {
    await pb.collection("_superusers").authWithPassword(email, password);
  } catch (err: any) {
    console.error(`PB auth failed against ${pbUrl}: ${err.message}`);
    process.exit(1);
  }
  console.log("  PB auth OK");
  return pb;
}

export interface LogInfo {
  id: string;
  ownerId: string;
  /** Validated IANA tz from the owner's user record (default America/Los_Angeles). */
  tz: string;
}

/**
 * Resolve the life logs to process: all of them, or just `--log <id>`.
 * Each log carries its owner's timezone for local-day bucketing.
 */
export async function resolveLogs(pb: PocketBase, onlyLogId?: string): Promise<LogInfo[]> {
  const records = onlyLogId
    ? [await pb.collection("life_logs").getOne(onlyLogId, { $autoCancel: false })]
    : await pb.collection("life_logs").getFullList({ $autoCancel: false });

  const logs: LogInfo[] = [];
  for (const rec of records) {
    const ownerId = (rec.owner as string) || "";
    let tzRaw: unknown;
    if (ownerId) {
      try {
        const user = await pb.collection("users").getOne(ownerId, { $autoCancel: false });
        tzRaw = user.timezone;
      } catch {
        tzRaw = undefined;
      }
    }
    logs.push({ id: rec.id, ownerId, tz: safeTz(tzRaw) });
  }
  return logs;
}

/**
 * Fetch this log's life_events matching a PB filter expression on subject_id,
 * normalized into the pure EventRow shape. The JS SDK returns JSON columns
 * already parsed (objects/arrays, or null when empty) — no goja byte-array
 * unwrapping needed outside of pb_migrations. We still guard with
 * Array.isArray in case a row has a null/odd entries column.
 */
export async function fetchEvents(
  pb: PocketBase,
  logId: string,
  subjectIds: string[],
): Promise<EventRow[]> {
  const subjectClause = subjectIds.map((_, i) => `subject_id = {:s${i}}`).join(" || ");
  const params: Record<string, string> = { logId };
  subjectIds.forEach((s, i) => (params[`s${i}`] = s));
  const records = await pb.collection("life_events").getFullList({
    filter: pb.filter(`log = {:logId} && (${subjectClause})`, params),
    sort: "timestamp,id", // id tiebreak keeps pagination stable across pages
    $autoCancel: false,
  });
  return records.map((r) => ({
    id: r.id,
    subject_id: (r.subject_id as string) || "",
    timestamp: r.timestamp as string,
    end_time: (r.end_time as string) || undefined,
    entries: Array.isArray(r.entries) ? (r.entries as Entry[]) : [],
    labels:
      r.labels && typeof r.labels === "object" && !Array.isArray(r.labels)
        ? (r.labels as Record<string, string>)
        : null,
    created_by: (r.created_by as string) || undefined,
  }));
}
