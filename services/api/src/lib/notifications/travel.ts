/**
 * Travel notifications: morning ("today's plan") + evening ("reflect").
 *
 * Trip-tz aware: each trip's timezone is derived from the first activity
 * with coordinates (lat/lng → IANA tz via tz-lookup). The hourly cron
 * fires both runs every hour; each run sends to a (user, trip) pair only
 * when the local hour in that trip's timezone equals the target hour.
 * Dedup is per (user, trip, date-in-trip-tz), so the same calendar day
 * across two trips in different tzs still fires twice (once per trip).
 *
 *   Morning (07:00 trip-local): pushes the day's plan, taps to open trip.
 *   Evening (20:00 trip-local): pushes a reflect prompt; suppressed when
 *     today's day_entry already has any text or highlight.
 *
 * Activeness is computed from the trip's start/end dates (interpreted in
 * the trip's tz), not the `status` field, since users rarely flip status.
 */
import type PocketBase from "pocketbase";
import { formatInTimeZone } from "date-fns-tz";
import tzlookup from "tz-lookup";
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";

const TRAVEL_ORIGINS = [`https://travel.${DOMAIN}`, `https://${DOMAIN}`];

// Used only when a trip has zero activities with coordinates. Matches the
// home-tz of the system owner so behavior is at least sensible for trips
// with placeholder data.
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
  category: string;
  lat: number | null;
  lng: number | null;
}

interface ActiveContext {
  userId: string;
  tripId: string;
  tripDestination: string;
  tripTz: string;
  todayInTz: string;       // YYYY-MM-DD in tripTz
  hourInTz: number;        // 0..23 in tripTz at the moment this run fires
  todayDay: ItineraryDay | null;
  activitiesById: Map<string, ActivitySummary>;
}

function ymdInTz(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "yyyy-MM-dd");
}

function hourInTz(d: Date, tz: string): number {
  return parseInt(formatInTimeZone(d, tz, "H"), 10);
}

function deriveTripTz(
  todayDay: ItineraryDay | null,
  activitiesById: Map<string, ActivitySummary>,
): string {
  // Prefer something from today's plan (most accurate when crossing tzs
  // mid-trip), otherwise any activity in the trip with coords.
  const todayCandidates: string[] = todayDay
    ? [
        ...(todayDay.flights ?? []).map((f) => f.activityId),
        ...(todayDay.lodgingActivityId ? [todayDay.lodgingActivityId] : []),
        ...(todayDay.slots ?? []).map((s) => s.activityId),
      ]
    : [];
  for (const id of todayCandidates) {
    const a = activitiesById.get(id);
    if (a && a.lat != null && a.lng != null) {
      try { return tzlookup(a.lat, a.lng); } catch { /* fall through */ }
    }
  }
  for (const a of activitiesById.values()) {
    if (a.lat != null && a.lng != null) {
      try { return tzlookup(a.lat, a.lng); } catch { /* fall through */ }
    }
  }
  return FALLBACK_TZ;
}

/**
 * Find every (user, currently-active trip) pair, with timezone resolved.
 * "Active" is judged in each trip's own timezone — a trip whose start_date
 * is today in Asia/Tokyo is active even if it's still yesterday in UTC.
 */
async function findActiveContexts(pb: PocketBase, now: Date): Promise<ActiveContext[]> {
  const out: ActiveContext[] = [];

  // Pull a permissive superset of trips first (any trip whose date window
  // *might* contain "today" in some tz), then filter by tz-aware comparison.
  // The superset bound is ±1 day in UTC.
  const utcToday = ymdInTz(now, "UTC");
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

  const activities = await pb.collection("travel_activities").getFullList({
    filter: tripFilter,
    fields: "id,trip_id,name,category,lat,lng",
    $autoCancel: false,
  });
  const itineraries = await pb.collection("travel_itineraries").getFullList({
    filter: tripFilter,
    $autoCancel: false,
  });

  for (const trip of trips) {
    const tripActivities = activities.filter((a) => a.trip_id === trip.id);
    const activitiesById = new Map<string, ActivitySummary>();
    for (const a of tripActivities) {
      activitiesById.set(a.id, {
        name: a.name || "",
        category: a.category || "",
        lat: a.lat ?? null,
        lng: a.lng ?? null,
      });
    }

    const tripItins = itineraries.filter((i) => i.trip_id === trip.id);
    const active = tripItins.find((i) => i.is_active) ?? tripItins[0];
    const days = (active?.days ?? []) as ItineraryDay[];
    const tz = deriveTripTz(null, activitiesById);
    const todayInTz = ymdInTz(now, tz);
    const todayDay = days.find((d) => d.date === todayInTz) ?? null;

    // Re-derive tz now that we have the day, since today's activities give
    // a more accurate result than any activity in the trip.
    const refinedTz = deriveTripTz(todayDay, activitiesById);
    const refinedToday = ymdInTz(now, refinedTz);
    const refinedHour = hourInTz(now, refinedTz);

    // Tz-aware activeness: start_date <= today (in tz) <= end_date (or open-ended).
    const startYmd = (trip.start_date as string || "").slice(0, 10);
    const endYmd = (trip.end_date as string || "").slice(0, 10);
    if (!startYmd || refinedToday < startYmd) continue;
    if (endYmd && refinedToday > endYmd) continue;

    const ownerIds: string[] = trip.expand?.log?.owners ?? [];
    for (const userId of ownerIds) {
      out.push({
        userId,
        tripId: trip.id,
        tripDestination: trip.destination || trip.name || "your trip",
        tripTz: refinedTz,
        todayInTz: refinedToday,
        hourInTz: refinedHour,
        todayDay,
        activitiesById,
      });
    }
  }

  return out;
}

function tripUrl(tripId: string): string {
  return `${TRAVEL_ORIGINS[0]}/trips/${tripId}`;
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
  // { [tripId]: ymdInTripTz } — last day we sent each kind for this trip.
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
 * per hour by the cron; per-trip-tz hour gating handles the actual timing.
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

  // Cache user records — multiple contexts may share a user.
  const userCache = new Map<string, Record<string, unknown>>();
  async function loadUser(userId: string): Promise<Record<string, unknown>> {
    const cached = userCache.get(userId);
    if (cached) return cached;
    const u = await pb.collection("users").getOne(userId, { $autoCancel: false }) as unknown as Record<string, unknown>;
    userCache.set(userId, u);
    return u;
  }

  let mNotified = 0, mSkipped = 0, eNotified = 0, eSkipped = 0;

  // For evening: prefetch today's day_entries so we can suppress the prompt
  // when the user has already journaled.
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

  for (const ctx of contexts) {
    const isMorning = ctx.hourInTz === MORNING_HOUR;
    const isEvening = ctx.hourInTz === EVENING_HOUR;
    if (!isMorning && !isEvening) continue;

    const user = await loadUser(ctx.userId);
    const dedup = readDedup(user as { travel_notif_state?: unknown });

    if (isMorning) {
      const last = dedup.morning?.[ctx.tripId];
      if (last === ctx.todayInTz) { mSkipped++; continue; }
      const result = await sendPushToUser(pb, ctx.userId, {
        title: `Today in ${ctx.tripDestination}`,
        body: summarizeTodayActivities(ctx),
        url: tripUrl(ctx.tripId),
        data: { type: "travel_morning", tripId: ctx.tripId },
      }, { preferredOrigins: TRAVEL_ORIGINS });
      console.log(`[travel-morning] User ${ctx.userId} trip ${ctx.tripId} (${ctx.tripTz}): ${result.sent} sent, ${result.expired} expired`);
      await writeDedup(pb, ctx.userId, dedup, "morning", ctx.tripId, ctx.todayInTz);
      mNotified++;
    }

    if (isEvening) {
      if (journaled.has(`${ctx.tripId}|${ctx.todayInTz}`)) { eSkipped++; continue; }
      const last = dedup.evening?.[ctx.tripId];
      if (last === ctx.todayInTz) { eSkipped++; continue; }
      const result = await sendPushToUser(pb, ctx.userId, {
        title: `How was today in ${ctx.tripDestination}?`,
        body: "Tap to record what you'll want to remember.",
        url: tripUrl(ctx.tripId),
        data: { type: "travel_evening", tripId: ctx.tripId },
      }, { preferredOrigins: TRAVEL_ORIGINS });
      console.log(`[travel-evening] User ${ctx.userId} trip ${ctx.tripId} (${ctx.tripTz}): ${result.sent} sent, ${result.expired} expired`);
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
