import type { Context } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { safeTz } from "../lib/notifications/tz";
import { fromZonedTime } from "date-fns-tz";
import {
  type EnsureSpec,
  ensureTrackables,
  findBySourceId,
  getOrCreateOwnLifeLog,
  isUniqueViolation,
} from "./life-ingest-shared";

/**
 * Phase-2b screen-time mapper.
 *
 * Served at POST /fn/screentime/ingest (the reverse proxy strips /fn). Behind
 * the global authMiddleware, so the caller's hlk_ / mcpat_ / PB token
 * identifies which user owns the data via c.get("userId"). Every write is
 * scoped to the CALLER'S OWN life log (resolved from userId — there is no
 * caller-supplied log id, so cross-user writes are structurally impossible),
 * and `created_by` is the userId.
 *
 * The phone companion app POSTs a rolling window of per-day screen-time
 * totals:
 *   { timestamp, app_version, device, source:"screen_time",
 *     screen_time: [ { date, total_screen_time_minutes, apps:[...] } ] }
 *
 * UPSERT-REPLACE semantics (NOT health's append/skip): the app re-sends ~7
 * days every sync and RESTATES them — today's total grows; past days can be
 * corrected. So each (log, source_id=`st:screen_time:<date>`) row is the
 * authoritative latest figure for that day. On each post we:
 *   - create the row if absent,
 *   - REPLACE its entries (total + apps JSON) if the total or apps changed,
 *   - skip it (count unchanged) if identical.
 * A lost create-race (unique violation on the partial index) re-reads and
 * applies the same compare/replace path so nothing is dropped.
 */

const ENSURE_SPECS: EnsureSpec[] = [
  { id: "screen_time", label: "Screen Time", shape: "took", group: "digital", defaultUnit: "min" },
];

type LifeEntry =
  | { name: string; type: "number"; value: number; unit: string }
  | { name: string; type: "text"; value: string };

type AppUsage = { package: string; name: string; minutes: number };

/**
 * Normalize the per-app array to the canonical {package,name,minutes} shape we
 * store, dropping anything else the device sends (e.g. last_used). The device
 * already filters >1min and sorts desc, so we keep order as-sent.
 */
function appsField(apps: unknown): AppUsage[] {
  if (!Array.isArray(apps)) return [];
  return apps.map((a) => {
    const r = (a ?? {}) as Record<string, unknown>;
    return {
      package: typeof r.package === "string" ? r.package : "",
      name: typeof r.name === "string" ? r.name : "",
      minutes: typeof r.minutes === "number" && Number.isFinite(r.minutes) ? r.minutes : 0,
    };
  });
}

/** Build the entries[] for a screen-time day. The number entry is always first. */
function buildEntries(totalMinutes: number, appsJson: string): LifeEntry[] {
  return [
    { name: "amount", type: "number", value: totalMinutes, unit: "min" },
    { name: "apps", type: "text", value: appsJson },
  ];
}

/** Extract (total, appsJson) from an existing event's entries for comparison. */
function readExisting(entries: unknown): { total: number | null; appsJson: string } {
  let total: number | null = null;
  let appsJson = "[]";
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const ent = (e ?? {}) as Record<string, unknown>;
      if (ent.name === "amount" && typeof ent.value === "number") total = ent.value;
      if (ent.name === "apps" && typeof ent.value === "string") appsJson = ent.value;
    }
  }
  return { total, appsJson };
}

export const screentimeIngestHandler = handler(async (c: Context<AppEnv>) => {
  const userId = c.get("userId") as string;
  const pb = c.get("pb");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "expected a JSON object body" }, 400);
  }

  const log = await getOrCreateOwnLifeLog(pb, userId);
  const logId = log.id as string;
  const device = typeof body.device === "string" ? body.device : "";

  // Owner timezone for the day→noon instant. The pod runs UTC, so the timestamp
  // must be computed through the owner's tz, not server-local time.
  let timeZone = "America/Los_Angeles";
  try {
    const owner = await pb.collection("users").getOne(log.owner as string);
    timeZone = safeTz(owner.timezone, "America/Los_Angeles");
  } catch {
    // owner unreadable → keep the fallback
  }

  await ensureTrackables(pb, log, ENSURE_SPECS);

  const days = Array.isArray(body.screen_time) ? (body.screen_time as Record<string, unknown>[]) : [];

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Apply one day's restated figures: create, replace-if-changed, or skip.
  // Shared by the create path and the lost-create-race (re-read) path so both
  // make the identical compare/replace decision.
  const applyDay = async (
    sourceId: string,
    timestamp: string,
    total: number,
    appsJson: string,
    labels: Record<string, string>,
    existing: { id: string; entries?: unknown } | null,
  ) => {
    const entries = buildEntries(total, appsJson);
    if (!existing) {
      try {
        await pb.collection("life_events").create({
          log: logId,
          subject_id: "screen_time",
          source_id: sourceId,
          timestamp,
          created_by: userId,
          entries,
          labels,
        });
        created++;
      } catch (err) {
        // A concurrent post created this day's row between our find and create.
        // Re-read and apply the same compare/replace path so this restatement
        // still lands. Other errors propagate.
        if (!isUniqueViolation(err)) throw err;
        const now = await findBySourceId(pb, logId, sourceId);
        if (now) await applyDay(sourceId, timestamp, total, appsJson, labels, now);
        else skipped++; // vanished again (delete race) — nothing to replace
      }
      return;
    }
    const prev = readExisting(existing.entries);
    if (prev.total === total && prev.appsJson === appsJson) {
      skipped++; // identical restatement — leave untouched
      return;
    }
    await pb.collection("life_events").update(existing.id, { entries, labels });
    updated++;
  };

  for (const d of days) {
    const date = typeof d.date === "string" ? d.date : "";
    if (!date) {
      skipped++; // no logical day → can't key it
      continue;
    }
    const total =
      typeof d.total_screen_time_minutes === "number" && Number.isFinite(d.total_screen_time_minutes)
        ? d.total_screen_time_minutes
        : null;
    if (total === null) {
      skipped++; // no usable total
      continue;
    }
    const appsJson = JSON.stringify(appsField(d.apps));
    const sourceId = `st:screen_time:${date}`;
    // Noon of the local day avoids any day-boundary rounding ambiguity.
    const timestamp = fromZonedTime(`${date}T12:00:00`, timeZone).toISOString();
    const labels: Record<string, string> = { source: "screen_time" };
    if (device) labels.device = device;

    const existing = (await findBySourceId(pb, logId, sourceId)) as { id: string; entries?: unknown } | null;
    await applyDay(sourceId, timestamp, total, appsJson, labels, existing);
  }

  return c.json({ ok: true, user: userId, written: { created, updated }, skipped });
});

/** Pure helpers exposed for unit tests (not part of the route surface). */
export const __test = { appsField, buildEntries, readExisting };
