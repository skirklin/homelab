import type { Context } from "hono";
import type PocketBase from "pocketbase";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { safeTz } from "../lib/notifications/tz";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

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
 *                    count.
 *
 * `heart_rate` is ignored entirely (tens of thousands of raw samples).
 */

/** Round to `digits` decimal places. */
export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

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
 * Pure: bucket interval records by their local-hour-start in `timeZone`.
 * `valueOf` extracts the additive value (null skips a record). Only records
 * whose `end_time` is strictly past `sinceHwm` are folded in — that's the
 * high-water-mark guard that makes re-posts/delta-syncs accumulate without
 * double counting. Returns one HourBucket per non-empty local hour.
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
    const endTime = (r.end_time as string) || startTime;
    if (endTime <= sinceHwm) continue; // already counted
    const value = valueOf(r);
    if (value === null) continue;
    const localHour = formatInTimeZone(new Date(startTime), timeZone, "yyyy-MM-dd'T'HH:00:00");
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

/** Default trackable rows the mapper ensures exist before writing. */
type EnsureSpec = {
  id: string;
  label: string;
  shape: "took" | "did";
  group: string;
  defaultUnit?: string;
};

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

type ManifestTrackable = { id: string; shape: string; [k: string]: unknown };
type Manifest = { trackables: ManifestTrackable[]; goals?: unknown[] };

/** Coerce a PB manifest JSON value into a Manifest, defaulting to empty. */
function manifestOf(raw: unknown): Manifest {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    if (Array.isArray(m.trackables)) {
      return {
        trackables: m.trackables as ManifestTrackable[],
        goals: Array.isArray(m.goals) ? (m.goals as unknown[]) : undefined,
      };
    }
  }
  return { trackables: [] };
}

/** Resolve the caller's OWN life log, creating it if absent. */
async function getOrCreateOwnLifeLog(pb: PocketBase, userId: string) {
  const logs = await pb.collection("life_logs").getList(1, 1, {
    filter: pb.filter("owner = {:uid}", { uid: userId }),
    sort: "created",
  });
  if (logs.items.length > 0) return logs.items[0];
  return pb.collection("life_logs").create({ name: "Life Log", owner: userId });
}

/** Find a life_event by (log, source_id), or null. */
async function findBySourceId(pb: PocketBase, logId: string, sourceId: string) {
  const list = await pb.collection("life_events").getList(1, 1, {
    filter: pb.filter("log = {:log} && source_id = {:sid}", { log: logId, sid: sourceId }),
  });
  return list.items[0] ?? null;
}

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
  const manifest = manifestOf(log.manifest);
  const existingIds = new Set(manifest.trackables.map((t) => t.id));
  let manifestChanged = false;
  for (const spec of ENSURE_SPECS) {
    if (existingIds.has(spec.id)) continue;
    const t: ManifestTrackable = { id: spec.id, label: spec.label, shape: spec.shape };
    if (spec.group) t.group = spec.group;
    if (spec.defaultUnit) t.defaultUnit = spec.defaultUnit;
    manifest.trackables.push(t);
    existingIds.add(spec.id);
    manifestChanged = true;
  }
  if (manifestChanged) {
    await pb.collection("life_logs").update(logId, { manifest });
  }

  const written: Record<string, number> = {};
  let skipped = 0;
  const bump = (subject: string) => {
    written[subject] = (written[subject] || 0) + 1;
  };

  // ---- 1:1 events ----
  // Insert only if a row with (log, source_id) doesn't already exist.
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
    await pb.collection("life_events").create(payload);
    bump(opts.subject);
  }

  const arr = (key: string): Record<string, unknown>[] => {
    const v = body[key];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  };

  for (const r of arr("weight")) {
    const time = r.time as string;
    if (!time || typeof r.kilograms !== "number") continue;
    await create1to1({
      subject: "weight",
      sourceId: `hc:weight:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(r.kilograms * KG_TO_LB, 1), unit: "lb" }],
    });
  }

  for (const r of arr("resting_heart_rate")) {
    const time = r.time as string;
    if (!time || typeof r.bpm !== "number") continue;
    await create1to1({
      subject: "resting_hr",
      sourceId: `hc:resting_hr:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: r.bpm, unit: "bpm" }],
    });
  }

  for (const r of arr("respiratory_rate")) {
    const time = r.time as string;
    if (!time || typeof r.rate !== "number") continue;
    await create1to1({
      subject: "respiratory_rate",
      sourceId: `hc:respiratory_rate:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(r.rate, 1), unit: "br/min" }],
    });
  }

  for (const r of arr("body_fat")) {
    const time = r.time as string;
    if (!time || typeof r.percentage !== "number") continue;
    await create1to1({
      subject: "body_fat",
      sourceId: `hc:body_fat:${time}`,
      timestamp: time,
      entries: [{ name: "amount", type: "number", value: round(r.percentage, 1), unit: "%" }],
    });
  }

  for (const r of arr("sleep")) {
    const end = r.session_end_time as string;
    if (!end || typeof r.duration_seconds !== "number") continue;
    // Start = first stage's start_time if present, else end minus duration.
    const stages = Array.isArray(r.stages) ? (r.stages as Record<string, unknown>[]) : [];
    const start =
      (stages[0]?.start_time as string) ||
      new Date(new Date(end).getTime() - r.duration_seconds * 1000).toISOString();
    await create1to1({
      subject: "sleep",
      sourceId: `hc:sleep:${end}`,
      timestamp: start,
      endTime: end,
      entries: [{ name: "duration", type: "number", value: round(r.duration_seconds / 60), unit: "min" }],
    });
  }

  for (const r of arr("exercise")) {
    const start = r.start_time as string;
    if (!start || typeof r.duration_seconds !== "number") continue;
    await create1to1({
      subject: "exercise",
      sourceId: `hc:exercise:${start}`,
      timestamp: start,
      endTime: (r.end_time as string) || undefined,
      labels: { category: exerciseCategory(r.type) },
      entries: [{ name: "duration", type: "number", value: round(r.duration_seconds / 60), unit: "min" }],
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

    // Bucket the full set once (sinceHwm="") to discover every touched hour
    // and its full sum (used for the create path).
    const fullBuckets = bucketHourly(records, timeZone, opts.valueOf);
    for (const [localHour, full] of fullBuckets) {
      const sourceId = `hc:${opts.subject}:${localHour}`;
      const existing = await findBySourceId(pb, logId, sourceId);
      // UTC instant of the local-hour start = the event timestamp.
      const timestamp = fromZonedTime(localHour, timeZone).toISOString();

      if (!existing) {
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
        continue;
      }

      // Fold in only records past the stored high-water mark for this hour.
      const prevHwm =
        (existing.labels && typeof existing.labels === "object" && (existing.labels as Record<string, string>).hwm) ||
        "";
      const delta = bucketHourly(records, timeZone, opts.valueOf, prevHwm).get(localHour);
      if (!delta || (delta.sum === 0 && delta.hwm === prevHwm)) {
        skipped++;
        continue; // nothing new past the hwm — leave untouched
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
    }
  }

  await aggregateHourly({
    arrayKey: "steps",
    subject: "steps",
    unit: "ct",
    digits: 0,
    valueOf: (r) => (typeof r.count === "number" ? r.count : null),
    finalize: (sum) => sum,
  });
  await aggregateHourly({
    arrayKey: "distance",
    subject: "distance",
    unit: "mi",
    digits: 2,
    valueOf: (r) => (typeof r.meters === "number" ? r.meters : null),
    finalize: (sum) => metersToMiles(sum),
  });
  await aggregateHourly({
    arrayKey: "total_calories",
    subject: "calories",
    unit: "kcal",
    digits: 1,
    valueOf: (r) => (typeof r.calories === "number" ? r.calories : null),
    finalize: (sum) => round(sum, 1),
  });

  return c.json({ ok: true, user: userId, written, skipped });
});
