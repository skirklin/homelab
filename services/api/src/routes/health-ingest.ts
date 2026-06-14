import type { Context } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { safeTz } from "../lib/notifications/tz";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  type EnsureSpec,
  ensureTrackables,
  findBySourceId,
  getOrCreateOwnLifeLog,
  isUniqueViolation,
  num,
  round,
} from "./life-ingest-shared";

// Re-export the shared numeric util the unit tests import from this module.
export { round };

/**
 * Phase-2 Health Connect mapper.
 *
 * Served at POST /fn/health/ingest (the reverse proxy strips /fn). Behind the
 * global authMiddleware, so the caller's hlk_ / mcpat_ / PB token identifies
 * which user owns the data via c.get("userId"). Multi-user: every write is
 * scoped to the CALLER'S OWN life log (resolved from userId — there is no
 * caller-supplied log id, so cross-user writes are structurally impossible),
 * and `created_by` is the userId.
 *
 * A phone companion app POSTs Health Connect data as
 *   { timestamp, app_version, source, <type arrays> }
 * where any per-type array may be absent. This handler maps each supported
 * record into `life_events` (the same collection /life/entries writes), with
 * two strategies:
 *
 *   1:1 events     — one life_event per source record, deduped by a
 *                    deterministic source_id (insert only if absent).
 *   hourly counters — high-volume interval records (steps/distance/calories)
 *                    aggregated into ONE event per local hour, with an
 *                    additive high-water-mark upsert so re-posts never double
 *                    count. The hwm is end_time-based, so the stored total is a
 *                    lower bound under RESTATEMENT (a corrected record sharing
 *                    an end instant past the hwm is dropped, not reconciled) —
 *                    fine for a single-device append-style feed.
 *
 * `heart_rate` is ignored entirely (tens of thousands of raw samples).
 */

export const KG_TO_LB = 2.20462;
export const M_TO_MI = 1609.344;

export function kgToLb(kilograms: number): number {
  return round(kilograms * KG_TO_LB, 1);
}

export function metersToMiles(meters: number): number {
  return round(meters / M_TO_MI, 2);
}

/** A local-hour aggregation bucket (raw, pre-finalize). */
export type HourBucket = {
  /** Local wall-clock hour-start key, e.g. "2026-06-14T07:00:00". */
  localHour: string;
  /** Sum of the records' raw values in this bucket. */
  sum: number;
  /** Max end_time among the bucket's records (high-water mark). */
  hwm: string;
};

/**
 * Canonicalize an ISO instant to its UTC `toISOString()` form, or "" if
 * unparseable. The high-water-mark guard compares end_times LEXICALLY, which
 * is only sound if every value is the same format/zone — normalizing here
 * removes that silent assumption (mixed `Z`/`+00:00`/precision can't mis-order).
 */
function canonInstant(iso: string): string {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

/**
 * Pure: bucket interval records by their local-hour-start in `timeZone`.
 * `valueOf` extracts the additive value (null skips a record). Only records
 * whose `end_time` is strictly past `sinceHwm` are folded in — that's the
 * high-water-mark guard that makes re-posts/delta-syncs accumulate without
 * double counting. `end_time`s are canonicalized so the lexical compare is
 * order-safe regardless of the source's ISO formatting.
 *
 * NOTE: end_time is treated as a unique high-water key — a distinct record
 * sharing an end instant at/before the hwm is dropped (undercount, never
 * double count). Fine for a single-device personal feed; flagged for clarity.
 * Returns one HourBucket per non-empty local hour.
 */
export function bucketHourly(
  records: Record<string, unknown>[],
  timeZone: string,
  valueOf: (r: Record<string, unknown>) => number | null,
  sinceHwm = "",
): Map<string, HourBucket> {
  const buckets = new Map<string, HourBucket>();
  for (const r of records) {
    const startTime = r.start_time as string;
    if (!startTime) continue;
    const startMs = new Date(startTime).getTime();
    if (Number.isNaN(startMs)) continue; // unparseable start_time — don't reach formatInTimeZone
    const endTime = canonInstant((r.end_time as string) || startTime);
    if (!endTime || endTime <= sinceHwm) continue; // unparseable or already counted
    const value = valueOf(r);
    if (value === null || !Number.isFinite(value)) continue;
    const localHour = formatInTimeZone(new Date(startMs), timeZone, "yyyy-MM-dd'T'HH:00:00");
    let b = buckets.get(localHour);
    if (!b) {
      b = { localHour, sum: 0, hwm: sinceHwm };
      buckets.set(localHour, b);
    }
    b.sum += value;
    if (endTime > b.hwm) b.hwm = endTime;
  }
  return buckets;
}

/**
 * A local-hour group carrying the records that fell in it (pre-fold). Bucketing
 * the FULL record array exactly ONCE into these groups, then folding each group
 * against a per-hour hwm, avoids re-running `bucketHourly` over the whole array
 * for every touched hour (the old O(N²) shape that could time out a backfill).
 */
export type HourGroup = {
  localHour: string;
  /** Records in this hour, each with its canonical end_time precomputed. */
  records: { value: number; endTime: string }[];
};

/**
 * Pure: bucket interval records by local-hour-start ONCE, retaining each
 * hour's records (value + canonical end_time) so per-hour folding can be done
 * without re-scanning the full array. Records with no `start_time`, an
 * unparseable `start_time`/`end_time`, or a non-finite value are skipped
 * (counted as malformed by the caller). One HourGroup per non-empty hour.
 */
export function groupHourly(
  records: Record<string, unknown>[],
  timeZone: string,
  valueOf: (r: Record<string, unknown>) => number | null,
): { groups: Map<string, HourGroup>; skipped: number } {
  const groups = new Map<string, HourGroup>();
  let skipped = 0;
  for (const r of records) {
    const startTime = r.start_time as string;
    if (!startTime) continue; // missing start: drop silently (matches no-value drop)
    const startMs = new Date(startTime).getTime();
    if (Number.isNaN(startMs)) {
      skipped++; // unparseable start_time — count as malformed, never reach formatInTimeZone
      continue;
    }
    const endTime = canonInstant((r.end_time as string) || startTime);
    if (!endTime) {
      skipped++; // unparseable end_time
      continue;
    }
    const value = valueOf(r);
    if (value === null || !Number.isFinite(value)) continue; // no/invalid value: drop
    const localHour = formatInTimeZone(new Date(startMs), timeZone, "yyyy-MM-dd'T'HH:00:00");
    let g = groups.get(localHour);
    if (!g) {
      g = { localHour, records: [] };
      groups.set(localHour, g);
    }
    g.records.push({ value, endTime });
  }
  return { groups, skipped };
}

/**
 * Pure: fold a single hour's pre-grouped records, counting only those whose
 * canonical `end_time` is strictly past `sinceHwm`. Returns the additive sum
 * and the new high-water mark. Mirrors `bucketHourly`'s hwm semantics exactly
 * (lexical compare on canonical instants), but operates on already-grouped
 * records so no full-array re-bucket is needed for the update path.
 */
export function foldGroup(group: HourGroup, sinceHwm = ""): { sum: number; hwm: string } {
  let sum = 0;
  let hwm = sinceHwm;
  for (const rec of group.records) {
    if (rec.endTime <= sinceHwm) continue; // already counted
    sum += rec.value;
    if (rec.endTime > hwm) hwm = rec.endTime;
  }
  return { sum, hwm };
}

/**
 * Map the frequent Health Connect ExerciseSessionRecord type enum ints
 * (sent as strings) to readable category names. The full enum is large; this
 * covers the common cases and falls back to "Workout". Refine as real data
 * surfaces unknown ints. (Values per androidx.health.connect ExerciseSessionRecord.)
 */
const EXERCISE_TYPE_NAMES: Record<string, string> = {
  "8": "Biking", // BIKING
  "9": "Biking (stationary)", // BIKING_STATIONARY
  "37": "HIIT", // HIGH_INTENSITY_INTERVAL_TRAINING
  "56": "Pilates",
  "57": "Pool swim",
  "79": "Running", // RUNNING
  "80": "Running (treadmill)", // RUNNING_TREADMILL
  "81": "Sailing",
  "82": "Scuba diving",
  "70": "Rowing",
  "71": "Rowing (machine)",
  "83": "Skating",
  "84": "Skiing",
  "85": "Snowboarding",
  "88": "Stair climbing",
  "97": "Strength training", // STRENGTH_TRAINING
  "98": "Stretching",
  "100": "Swimming (open water)",
  "101": "Swimming (pool)",
  "104": "Tennis",
  "116": "Walking", // WALKING
  "117": "Water polo",
  "120": "Weightlifting",
  "122": "Workout", // WORKOUT (generic / "other")
  "13": "Boot camp",
  "16": "Calisthenics",
  "52": "Hiking",
  "54": "Pilates (mat)",
};

function exerciseCategory(type: unknown): string {
  return (typeof type === "string" && EXERCISE_TYPE_NAMES[type]) || "Workout";
}

// `took` subjects we may write; auto-added with a sensible label/group/unit.
// `sleep`/`exercise` are added only if absent (`did` shape), never overwritten.
const ENSURE_SPECS: EnsureSpec[] = [
  { id: "weight", label: "Weight", shape: "took", group: "body", defaultUnit: "lb" },
  { id: "resting_hr", label: "Resting HR", shape: "took", group: "body", defaultUnit: "bpm" },
  { id: "respiratory_rate", label: "Respiratory rate", shape: "took", group: "body", defaultUnit: "br/min" },
  { id: "body_fat", label: "Body fat", shape: "took", group: "body", defaultUnit: "%" },
  { id: "steps", label: "Steps", shape: "took", group: "activity", defaultUnit: "ct" },
  { id: "distance", label: "Distance", shape: "took", group: "activity", defaultUnit: "mi" },
  { id: "calories", label: "Calories", shape: "took", group: "activity", defaultUnit: "kcal" },
  { id: "sleep", label: "Sleep", shape: "did", group: "body" },
  { id: "exercise", label: "Exercise", shape: "did", group: "activity" },
];

type LifeEntry = { name: string; type: "number"; value: number; unit: string };

export const healthIngestHandler = handler(async (c: Context<AppEnv>) => {
  const userId = c.get("userId") as string;
  const pb = c.get("pb");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "expected a JSON object body" }, 400);
  }

  const log = await getOrCreateOwnLifeLog(pb, userId);
  const logId = log.id as string;

  // Owner timezone for hour/day bucketing — the pod runs UTC, so all boundary
  // math goes through the owner's tz. (Same fallback the life notifier uses.)
  let timeZone = "America/Los_Angeles";
  try {
    const owner = await pb.collection("users").getOne(log.owner as string);
    timeZone = safeTz(owner.timezone, "America/Los_Angeles");
  } catch {
    // owner unreadable → keep the fallback
  }

  // ---- Ensure trackables exist (append-only; never clobber existing) ----
  // Optimistic read-modify-write with a small retry loop: a blind whole-document
  // update would last-writer-win over a concurrent life-app manifest edit (the
  // recipe_boxes corruption failure shape). Each attempt RE-READS the current
  // manifest, appends ONLY the still-missing trackable specs (existing ids are
  // never modified — id+shape are immutable — and goals are carried through
  // untouched), and updates. On a version/conflict error we retry against the
  // fresh manifest; after a few failed attempts we fail loud rather than risk a
  // silent overwrite.
  await ensureTrackables(pb, log, ENSURE_SPECS);

  const written: Record<string, number> = {};
  let skipped = 0;
  const bump = (subject: string) => {
    written[subject] = (written[subject] || 0) + 1;
  };

  // ---- 1:1 events ----
  // Insert only if a row with (log, source_id) doesn't already exist.
  //
  // source_id scheme: `hc:<subject>:<instant>` keyed on the record's own
  // timestamp. ACCEPTED ASSUMPTION: two DISTINCT records of the same subject
  // that share an instant (e.g. two weigh-ins recorded at the exact same time)
  // collide on source_id, so the later one is skipped (deduped). Acceptable for
  // a single-device personal feed where same-instant duplicates are
  // restatements, not genuinely independent readings.
  async function create1to1(opts: {
    subject: string;
    sourceId: string;
    timestamp: string;
    entries: LifeEntry[];
    endTime?: string;
    labels?: Record<string, string>;
  }) {
    const existing = await findBySourceId(pb, logId, opts.sourceId);
    if (existing) {
      skipped++;
      return;
    }
    const payload: Record<string, unknown> = {
      log: logId,
      subject_id: opts.subject,
      source_id: opts.sourceId,
      timestamp: opts.timestamp,
      created_by: userId,
      entries: opts.entries,
    };
    if (opts.endTime) payload.end_time = opts.endTime;
    if (opts.labels && Object.keys(opts.labels).length > 0) payload.labels = opts.labels;
    try {
      await pb.collection("life_events").create(payload);
    } catch (err) {
      // A concurrent/retried post raced us past the find-by-source_id check and
      // inserted first → the partial unique (log, source_id) index rejects ours.
      // Treat as already-exists (skip), don't 500. Other errors propagate.
      if (isUniqueViolation(err)) {
        skipped++;
        return;
      }
      throw err;
    }
    bump(opts.subject);
  }

  const arr = (key: string): Record<string, unknown>[] => {
    const v = body[key];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  };

  for (const r of arr("weight")) {
    const time = r.time as string;
    const kg = num(r.kilograms);
    if (!time || kg === null) continue;
    await create1to1({
      subject: "weight",
      sourceId: `hc:weight:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(kg * KG_TO_LB, 1), unit: "lb" }],
    });
  }

  for (const r of arr("resting_heart_rate")) {
    const time = r.time as string;
    const bpm = num(r.bpm);
    if (!time || bpm === null) continue;
    await create1to1({
      subject: "resting_hr",
      sourceId: `hc:resting_hr:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: bpm, unit: "bpm" }],
    });
  }

  for (const r of arr("respiratory_rate")) {
    const time = r.time as string;
    const rate = num(r.rate);
    if (!time || rate === null) continue;
    await create1to1({
      subject: "respiratory_rate",
      sourceId: `hc:respiratory_rate:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(rate, 1), unit: "br/min" }],
    });
  }

  for (const r of arr("body_fat")) {
    const time = r.time as string;
    const pct = num(r.percentage);
    if (!time || pct === null) continue;
    await create1to1({
      subject: "body_fat",
      sourceId: `hc:body_fat:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(pct, 1), unit: "%" }],
    });
  }

  for (const r of arr("sleep")) {
    const end = r.session_end_time as string;
    const durSec = num(r.duration_seconds);
    if (!end || durSec === null) continue;
    // Start = first stage's start_time if present, else end minus duration.
    const stages = Array.isArray(r.stages) ? (r.stages as Record<string, unknown>[]) : [];
    const start =
      (stages[0]?.start_time as string) ||
      new Date(new Date(end).getTime() - durSec * 1000).toISOString();
    await create1to1({
      subject: "sleep",
      sourceId: `hc:sleep:${end}`,
      timestamp: start,
      endTime: end,
      entries: [{ name: "duration", type: "number", value: round(durSec / 60), unit: "min" }],
    });
  }

  for (const r of arr("exercise")) {
    const start = r.start_time as string;
    const durSec = num(r.duration_seconds);
    if (!start || durSec === null) continue;
    await create1to1({
      subject: "exercise",
      sourceId: `hc:exercise:${start}`,
      timestamp: start,
      endTime: (r.end_time as string) || undefined,
      labels: { category: exerciseCategory(r.type) },
      entries: [{ name: "duration", type: "number", value: round(durSec / 60), unit: "min" }],
    });
  }

  // ---- Hourly-aggregated counters (steps / distance / total_calories) ----
  // Bucket each interval record by its local-hour-start (in the owner's tz),
  // then additive-upsert with a high-water-mark so re-posts / delta-syncs never
  // double count. `finalize` maps a raw sum to the stored unit (meters→miles
  // etc.); `digits` is the canonical precision the combined total is rounded to.
  async function aggregateHourly(opts: {
    arrayKey: string;
    subject: string;
    unit: string;
    digits: number;
    /** extract the additive value from a record, or null to skip it. */
    valueOf: (r: Record<string, unknown>) => number | null;
    /** post-aggregation transform of a raw sum (e.g. meters→miles). */
    finalize: (sum: number) => number;
  }) {
    const records = arr(opts.arrayKey);
    if (records.length === 0) return;

    // Bucket the full set ONCE into per-hour groups carrying their records.
    // Every touched hour then folds against its own stored hwm off this single
    // grouping — no per-hour re-bucket of the full array (the old O(N²) shape).
    const { groups, skipped: malformed } = groupHourly(records, timeZone, opts.valueOf);
    skipped += malformed; // unparseable start_time/end_time count as skipped

    // Fold this hour's group into an existing row by its stored hwm and update
    // (or skip if nothing new). Shared by the found-path and the lost-create
    // race (re-read) path so both apply identical hwm/fold semantics.
    const foldIntoExisting = async (group: HourGroup, existing: { id: string; labels?: unknown; entries?: unknown }) => {
      const labels = existing.labels as Record<string, string> | null | undefined;
      const rawHwm = (labels && typeof labels === "object" && labels.hwm) || "";
      const prevHwm = rawHwm ? canonInstant(rawHwm) : "";
      const delta = foldGroup(group, prevHwm);
      if (delta.sum === 0 && delta.hwm === prevHwm) {
        skipped++;
        return; // nothing new past the hwm — leave untouched
      }
      const existingValue =
        Array.isArray(existing.entries) && existing.entries[0] && typeof existing.entries[0].value === "number"
          ? (existing.entries[0].value as number)
          : 0;
      // existing stored value is already finalized; fold in the finalized delta.
      // finalize is linear, so finalize(a)+finalize(b) == finalize(a+b) up to
      // rounding — round the combined total to keep canonical precision.
      const combined = round(existingValue + opts.finalize(delta.sum), opts.digits);
      await pb.collection("life_events").update(existing.id, {
        entries: [{ name: "amount", type: "number", value: combined, unit: opts.unit }],
        labels: { hwm: delta.hwm },
      });
      bump(opts.subject);
    };

    for (const [localHour, group] of groups) {
      const sourceId = `hc:${opts.subject}:${localHour}`;
      const existing = await findBySourceId(pb, logId, sourceId);
      // UTC instant of the local-hour start = the event timestamp.
      const timestamp = fromZonedTime(localHour, timeZone).toISOString();

      if (existing) {
        await foldIntoExisting(group, existing);
        continue;
      }

      // No row yet → create the full-hour total (sinceHwm="").
      const full = foldGroup(group);
      try {
        await pb.collection("life_events").create({
          log: logId,
          subject_id: opts.subject,
          source_id: sourceId,
          timestamp,
          created_by: userId,
          entries: [{ name: "amount", type: "number", value: opts.finalize(full.sum), unit: opts.unit }],
          labels: { hwm: full.hwm },
        });
        bump(opts.subject);
      } catch (err) {
        // A concurrent post created this hour's row between our find and create.
        // Re-read it and apply the SAME additive-fold/hwm update so this call's
        // records still accumulate (rather than being dropped). Other errors
        // propagate.
        if (!isUniqueViolation(err)) throw err;
        const now = await findBySourceId(pb, logId, sourceId);
        if (now) await foldIntoExisting(group, now);
        else skipped++; // vanished again (delete race) — nothing to fold into
      }
    }
  }

  await aggregateHourly({
    arrayKey: "steps",
    subject: "steps",
    unit: "ct",
    digits: 0,
    valueOf: (r) => num(r.count),
    finalize: (sum) => sum,
  });
  await aggregateHourly({
    arrayKey: "distance",
    subject: "distance",
    unit: "mi",
    digits: 2,
    valueOf: (r) => num(r.meters),
    finalize: (sum) => metersToMiles(sum),
  });
  await aggregateHourly({
    arrayKey: "total_calories",
    subject: "calories",
    unit: "kcal",
    digits: 1,
    valueOf: (r) => num(r.calories),
    finalize: (sum) => round(sum, 1),
  });

  return c.json({ ok: true, user: userId, written, skipped });
});
