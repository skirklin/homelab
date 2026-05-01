/**
 * Travel notifications: morning ("today's plan") + evening ("reflect").
 *
 * Trip-tz aware via the user's stored timezone. Each kirkl.in app pushes the
 * browser's current `Intl.DateTimeFormat().resolvedOptions().timeZone` to
 * `users.timezone` on every visit (see packages/ui backend-provider). The
 * cron ticks every hour; this function fires for a (user, trip) pair only
 * when the local hour in user.timezone equals the target hour.
 *
 *   Morning (07:00 user-local): pushes the day's plan, taps to open trip.
 *   Evening (20:00 user-local): pushes a reflect prompt; suppressed when
 *     today's day_entry already has any text or highlight.
 *
 * Activeness is computed from the trip's start/end dates (interpreted in
 * user.timezone), not the `status` field.
 */
import type PocketBase from "pocketbase";
import { formatInTimeZone } from "date-fns-tz";
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";

const TRAVEL_ORIGINS = [`https://travel.${DOMAIN}`, `https://${DOMAIN}`];

// Used when a user has no timezone field set yet (haven't visited a kirkl.in
// app since the timezone-push feature shipped). Matches the system owner.
const FALLBACK_TZ = "America/Denver";

const MORNING_HOUR = 7;
const EVENING_HOUR = 20;

interface ItineraryDay {
  date?: string;
  label?: string;
  lodgingActivityId?: string;
  flights?: { activityId: string; startTime?: string }[];
  slots: { activityId: string; startTime?: string }[];
}

interface ActivitySummary {
  name: string;
}

interface ActiveContext {
  userId: string;
  userTz: string;
  tripId: string;
  tripDestination: string;
  todayInTz: string;
  hourInTz: number;
  todayDay: ItineraryDay | null;
  activitiesById: Map<string, ActivitySummary>;
}

function ymdInTz(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "yyyy-MM-dd");
}

function hourInTzOf(d: Date, tz: string): number {
  return parseInt(formatInTimeZone(d, tz, "H"), 10);
}

function safeTz(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return FALLBACK_TZ;
  try {
    // Validate by attempting a format — invalid tz throws.
    formatInTimeZone(new Date(), tz, "yyyy");
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

/**
 * Find every (user, currently-active trip) pair, with the user's tz applied.
 * "Active" is judged in the user's tz so a trip whose start_date is today in
 * user-local is active even if it's still yesterday in UTC.
 */
async function findActiveContexts(pb: PocketBase, now: Date): Promise<ActiveContext[]> {
  const out: ActiveContext[] = [];

  const utcYesterday = ymdInTz(new Date(now.getTime() - 24 * 3600 * 1000), "UTC");
  const utcTomorrow = ymdInTz(new Date(now.getTime() + 24 * 3600 * 1000), "UTC");
  const trips = await pb.collection("travel_trips").getFullList({
    filter: pb.filter(
      'start_date != "" && start_date <= {:endBound} && (end_date = "" || end_date >= {:startBound})',
      {
        startBound: `${utcYesterday} 00:00:00.000Z`,
        endBound: `${utcTomorrow} 23:59:59.999Z`,
      },
    ),
    expand: "log",
    $autoCancel: false,
  });

  if (trips.length === 0) return out;

  const tripIds = trips.map((t) => t.id);
  const tripFilter = tripIds.map((id) => pb.filter("trip_id = {:id}", { id })).join(" || ");

  const [activities, itineraries] = await Promise.all([
    pb.collection("travel_activities").getFullList({
      filter: tripFilter,
      fields: "id,trip_id,name",
      $autoCancel: false,
    }),
    pb.collection("travel_itineraries").getFullList({
      filter: tripFilter,
      $autoCancel: false,
    }),
  ]);

  // Cache user records by id; one user often owns multiple trips.
  const userTzCache = new Map<string, string>();
  async function tzForUser(userId: string): Promise<string> {
    const hit = userTzCache.get(userId);
    if (hit) return hit;
    const u = await pb.collection("users").getOne(userId, { $autoCancel: false });
    const tz = safeTz(u.timezone);
    userTzCache.set(userId, tz);
    return tz;
  }

  for (const trip of trips) {
    const tripActivities = activities.filter((a) => a.trip_id === trip.id);
    const activitiesById = new Map<string, ActivitySummary>();
    for (const a of tripActivities) {
      activitiesById.set(a.id, { name: a.name || "" });
    }

    const tripItins = itineraries.filter((i) => i.trip_id === trip.id);
    const active = tripItins.find((i) => i.is_active) ?? tripItins[0];
    const days = (active?.days ?? []) as ItineraryDay[];

    const ownerIds: string[] = trip.expand?.log?.owners ?? [];
    for (const userId of ownerIds) {
      const tz = await tzForUser(userId);
      const todayInTz = ymdInTz(now, tz);
      const todayDay = days.find((d) => d.date === todayInTz) ?? null;

      // Tz-aware activeness check.
      const startYmd = (trip.start_date as string || "").slice(0, 10);
      const endYmd = (trip.end_date as string || "").slice(0, 10);
      if (!startYmd || todayInTz < startYmd) continue;
      if (endYmd && todayInTz > endYmd) continue;

      out.push({
        userId,
        userTz: tz,
        tripId: trip.id,
        tripDestination: trip.destination || trip.name || "your trip",
        todayInTz,
        hourInTz: hourInTzOf(now, tz),
        todayDay,
        activitiesById,
      });
    }
  }

  return out;
}

function tripUrl(tripId: string): string {
  // Travel app routes mount tripId directly at the root (no `/trips/` prefix):
  //   travel.kirkl.in/{tripId} → TripDetail
  return `${TRAVEL_ORIGINS[0]}/${tripId}`;
}

function dayUrl(tripId: string, date: string): string {
  // Day route: travel.kirkl.in/{tripId}/day/{YYYY-MM-DD} → DayView
  return `${TRAVEL_ORIGINS[0]}/${tripId}/day/${date}`;
}

function summarizeTodayActivities(ctx: ActiveContext): string {
  const day = ctx.todayDay;
  if (!day) return "Open the app to see your plan";
  const all = [
    ...(day.flights ?? []).map((f) => ctx.activitiesById.get(f.activityId)?.name).filter(Boolean) as string[],
    ...(day.slots ?? []).map((s) => ctx.activitiesById.get(s.activityId)?.name).filter(Boolean) as string[],
  ];
  if (all.length === 0) return "No activities scheduled — free day";
  if (all.length <= 3) return all.join(", ");
  return `${all.slice(0, 3).join(", ")} and ${all.length - 3} more`;
}

interface DedupState {
  morning?: Record<string, string>;
  evening?: Record<string, string>;
}

function readDedup(user: { travel_notif_state?: unknown }): DedupState {
  const v = user.travel_notif_state;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as DedupState;
  return {};
}

async function writeDedup(
  pb: PocketBase,
  userId: string,
  current: DedupState,
  kind: "morning" | "evening",
  tripId: string,
  ymd: string,
): Promise<void> {
  const next = { ...current };
  next[kind] = { ...(current[kind] ?? {}), [tripId]: ymd };
  await pb.collection("users").update(userId, { travel_notif_state: next }, { $autoCancel: false });
}

/**
 * Run morning + evening checks against `now`. Designed to be called once
 * per hour by the cron; per-user-tz hour gating handles the actual timing.
 */
export async function runTravelNotificationsTick(now: Date = new Date()): Promise<{
  morning: { notified: number; skipped: number };
  evening: { notified: number; skipped: number };
}> {
  const pb = await getAdminPb();
  const contexts = await findActiveContexts(pb, now);
  if (contexts.length === 0) {
    console.log(`[travel-tick] No active trips`);
    return { morning: { notified: 0, skipped: 0 }, evening: { notified: 0, skipped: 0 } };
  }

  const userCache = new Map<string, Record<string, unknown>>();
  async function loadUser(userId: string): Promise<Record<string, unknown>> {
    const cached = userCache.get(userId);
    if (cached) return cached;
    const u = await pb.collection("users").getOne(userId, { $autoCancel: false }) as unknown as Record<string, unknown>;
    userCache.set(userId, u);
    return u;
  }

  // For evening: prefetch today's day_entries to suppress if already journaled.
  const tripDateKeys = new Set(contexts.map((c) => `${c.tripId}|${c.todayInTz}`));
  const tripIds = [...new Set(contexts.map((c) => c.tripId))];
  const dateValues = [...new Set(contexts.map((c) => c.todayInTz))];
  const journaled = new Set<string>();
  if (tripIds.length > 0 && dateValues.length > 0) {
    const filter = pb.filter(
      `(${tripIds.map((id) => pb.filter("trip = {:id}", { id })).join(" || ")})` +
      ` && (${dateValues.map((d) => pb.filter("date = {:d}", { d })).join(" || ")})`,
      {},
    );
    const rows = await pb.collection("travel_day_entries").getFullList({ filter, $autoCancel: false });
    for (const r of rows) {
      const key = `${r.trip}|${r.date}`;
      if (!tripDateKeys.has(key)) continue;
      const filled = (r.text || "").trim().length > 0 || (r.highlight || "").trim().length > 0;
      if (filled) journaled.add(key);
    }
  }

  let mNotified = 0, mSkipped = 0, eNotified = 0, eSkipped = 0;

  for (const ctx of contexts) {
    const isMorning = ctx.hourInTz === MORNING_HOUR;
    const isEvening = ctx.hourInTz === EVENING_HOUR;
    if (!isMorning && !isEvening) continue;

    const user = await loadUser(ctx.userId);
    const dedup = readDedup(user as { travel_notif_state?: unknown });

    if (isMorning) {
      const last = dedup.morning?.[ctx.tripId];
      if (last === ctx.todayInTz) { mSkipped++; continue; }
      const url = ctx.todayDay
        ? dayUrl(ctx.tripId, ctx.todayInTz)
        : tripUrl(ctx.tripId);
      const result = await sendPushToUser(pb, ctx.userId, {
        title: `Today in ${ctx.tripDestination}`,
        body: summarizeTodayActivities(ctx),
        url,
        data: { type: "travel_morning", tripId: ctx.tripId, date: ctx.todayInTz },
      }, { preferredOrigins: TRAVEL_ORIGINS });
      console.log(`[travel-morning] User ${ctx.userId} trip ${ctx.tripId} (${ctx.userTz}): ${result.sent} sent, ${result.expired} expired`);
      await writeDedup(pb, ctx.userId, dedup, "morning", ctx.tripId, ctx.todayInTz);
      mNotified++;
    }

    if (isEvening) {
      if (journaled.has(`${ctx.tripId}|${ctx.todayInTz}`)) { eSkipped++; continue; }
      const last = dedup.evening?.[ctx.tripId];
      if (last === ctx.todayInTz) { eSkipped++; continue; }
      const url = ctx.todayDay
        ? dayUrl(ctx.tripId, ctx.todayInTz)
        : tripUrl(ctx.tripId);
      const result = await sendPushToUser(pb, ctx.userId, {
        title: `How was today in ${ctx.tripDestination}?`,
        body: "Tap to record what you'll want to remember.",
        url,
        data: { type: "travel_evening", tripId: ctx.tripId, date: ctx.todayInTz },
      }, { preferredOrigins: TRAVEL_ORIGINS });
      console.log(`[travel-evening] User ${ctx.userId} trip ${ctx.tripId} (${ctx.userTz}): ${result.sent} sent, ${result.expired} expired`);
      await writeDedup(pb, ctx.userId, dedup, "evening", ctx.tripId, ctx.todayInTz);
      eNotified++;
    }
  }

  console.log(`[travel-tick] morning=${mNotified} skipped=${mSkipped} evening=${eNotified} skipped=${eSkipped}`);
  return {
    morning: { notified: mNotified, skipped: mSkipped },
    evening: { notified: eNotified, skipped: eSkipped },
  };
}
