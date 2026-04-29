/**
 * Travel notifications: morning (today's itinerary) + evening (reflect prompt).
 *
 *   Morning: for each user with an active trip, sends a push listing the
 *     top scheduled activities for today.
 *   Evening: prompts the user to reflect, deep-linking into the trip page.
 *     Skips when today's day-entry already has any text or highlight, so
 *     re-running won't nag a user who already journaled.
 *
 * Activeness is computed from the trip's start/end dates, not its `status`
 * field, because most trips never get their status flipped manually.
 */
import type PocketBase from "pocketbase";
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";

// Travel is reachable at travel.<domain> and as a module under <domain>/travel.
const TRAVEL_ORIGINS = [`https://travel.${DOMAIN}`, `https://${DOMAIN}`];

// All cron schedules + per-user dedup are interpreted in this timezone.
// User is in MDT; if they ever travel often to a different tz we can revisit.
const HOME_TZ = "America/Denver";

interface ItineraryDay {
  date?: string;        // YYYY-MM-DD
  label?: string;
  lodgingActivityId?: string;
  flights?: { activityId: string; startTime?: string }[];
  slots: { activityId: string; startTime?: string }[];
}

function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: HOME_TZ });
}

function ymd(date: string | Date): string {
  // Trip dates are stored as ISO strings (sometimes empty). Take the first 10
  // characters when they look ISO; otherwise let Date parse them.
  if (typeof date === "string") {
    if (date.length >= 10 && date[4] === "-" && date[7] === "-") return date.slice(0, 10);
    return new Date(date).toLocaleDateString("en-CA", { timeZone: HOME_TZ });
  }
  return date.toLocaleDateString("en-CA", { timeZone: HOME_TZ });
}

interface ActiveContext {
  userId: string;
  tripId: string;
  tripDestination: string;
  todayDay: ItineraryDay | null;
  activitiesById: Map<string, { name: string; category: string }>;
}

/**
 * Find every (user, currently-active trip) pair, with the active itinerary's
 * day matching today loaded out. Returns one ActiveContext per user-trip;
 * a user with two active trips will appear twice (rare but valid).
 */
async function findActiveContexts(pb: PocketBase, today: string): Promise<ActiveContext[]> {
  const out: ActiveContext[] = [];

  // Trips whose date window covers today. PB stores start_date / end_date
  // as ISO strings; lexicographic comparison on the YYYY-MM-DD prefix works.
  const trips = await pb.collection("travel_trips").getFullList({
    filter: pb.filter(
      "start_date != \"\" && start_date <= {:today} && (end_date = \"\" || end_date >= {:today})",
      { today: `${today} 23:59:59.999Z` },
    ),
    expand: "log",
    $autoCancel: false,
  });

  if (trips.length === 0) return out;

  // Index activities and itineraries by trip in single batched fetches.
  const tripIds = trips.map((t) => t.id);
  const tripFilter = tripIds.map((id) => pb.filter("trip_id = {:id}", { id })).join(" || ");

  const activities = await pb.collection("travel_activities").getFullList({
    filter: tripFilter,
    fields: "id,trip_id,name,category",
    $autoCancel: false,
  });
  const itineraries = await pb.collection("travel_itineraries").getFullList({
    filter: tripFilter,
    $autoCancel: false,
  });

  for (const trip of trips) {
    const tripActivities = activities.filter((a) => a.trip_id === trip.id);
    const activitiesById = new Map<string, { name: string; category: string }>();
    for (const a of tripActivities) {
      activitiesById.set(a.id, { name: a.name || "", category: a.category || "" });
    }

    // Active itinerary, falling back to the first one for this trip.
    const tripItins = itineraries.filter((i) => i.trip_id === trip.id);
    const active = tripItins.find((i) => i.is_active) ?? tripItins[0];
    const days = (active?.days ?? []) as ItineraryDay[];
    const todayDay = days.find((d) => d.date === today) ?? null;

    const ownerIds: string[] = trip.expand?.log?.owners ?? [];
    for (const userId of ownerIds) {
      out.push({
        userId,
        tripId: trip.id,
        tripDestination: trip.destination || trip.name || "your trip",
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

  const slots = day.slots ?? [];
  const flights = day.flights ?? [];
  const all = [
    ...flights.map((f) => ctx.activitiesById.get(f.activityId)?.name).filter(Boolean) as string[],
    ...slots.map((s) => ctx.activitiesById.get(s.activityId)?.name).filter(Boolean) as string[],
  ];

  if (all.length === 0) return "No activities scheduled — free day";
  if (all.length <= 3) return all.join(", ");
  return `${all.slice(0, 3).join(", ")} and ${all.length - 3} more`;
}

/**
 * Send a morning notification per user with an active trip. Idempotent for the
 * day via `last_travel_notif_morning`, so re-runs the same day won't double-send.
 */
export async function runTravelMorningNotifications(): Promise<{ notified: number; skipped: number }> {
  const pb = await getAdminPb();
  const today = todayLocal();
  console.log(`[travel-morning] Starting check for ${today}`);

  const contexts = await findActiveContexts(pb, today);
  if (contexts.length === 0) {
    console.log(`[travel-morning] No active trips`);
    return { notified: 0, skipped: 0 };
  }

  // Group contexts by user — one push per user even if they have multiple
  // overlapping trips (uncommon but valid).
  const byUser = new Map<string, ActiveContext[]>();
  for (const ctx of contexts) {
    const list = byUser.get(ctx.userId) ?? [];
    list.push(ctx);
    byUser.set(ctx.userId, list);
  }

  let notified = 0;
  let skipped = 0;

  for (const [userId, userContexts] of byUser) {
    const user = await pb.collection("users").getOne(userId, { $autoCancel: false });

    // Dedup against today, in HOME_TZ.
    if (user.last_travel_notif_morning) {
      const last = ymd(user.last_travel_notif_morning);
      if (last === today) {
        skipped++;
        continue;
      }
    }

    // Pick the trip whose day-of has the most concrete plan; fall back to first.
    const primary = userContexts.find((c) => c.todayDay) ?? userContexts[0];
    const title = `Today in ${primary.tripDestination}`;
    const body = summarizeTodayActivities(primary);

    const result = await sendPushToUser(pb, userId, {
      title,
      body,
      url: tripUrl(primary.tripId),
      data: { type: "travel_morning", tripId: primary.tripId },
    }, { preferredOrigins: TRAVEL_ORIGINS });

    console.log(`[travel-morning] User ${userId}: ${result.sent} sent, ${result.expired} expired`);

    await pb.collection("users").update(userId, {
      last_travel_notif_morning: new Date().toISOString(),
    }, { $autoCancel: false });

    notified++;
  }

  console.log(`[travel-morning] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}

/**
 * Send an evening "reflect on today" notification per user with an active trip.
 * Skipped when today's day_entry already has text or a highlight — don't nag
 * users who already journaled.
 */
export async function runTravelEveningNotifications(): Promise<{ notified: number; skipped: number }> {
  const pb = await getAdminPb();
  const today = todayLocal();
  console.log(`[travel-evening] Starting check for ${today}`);

  const contexts = await findActiveContexts(pb, today);
  if (contexts.length === 0) {
    console.log(`[travel-evening] No active trips`);
    return { notified: 0, skipped: 0 };
  }

  // Existing entries for today across these trips, fetched once.
  const tripIds = [...new Set(contexts.map((c) => c.tripId))];
  const tripFilter = tripIds.map((id) => pb.filter("trip = {:id}", { id })).join(" || ");
  const todayEntries = tripIds.length > 0
    ? await pb.collection("travel_day_entries").getFullList({
        filter: pb.filter(`(${tripFilter}) && date = {:date}`, { date: today }),
        $autoCancel: false,
      })
    : [];
  const journaledTrips = new Set(
    todayEntries
      .filter((e) => (e.text || "").trim().length > 0 || (e.highlight || "").trim().length > 0)
      .map((e) => e.trip),
  );

  const byUser = new Map<string, ActiveContext[]>();
  for (const ctx of contexts) {
    const list = byUser.get(ctx.userId) ?? [];
    list.push(ctx);
    byUser.set(ctx.userId, list);
  }

  let notified = 0;
  let skipped = 0;

  for (const [userId, userContexts] of byUser) {
    // If every active trip already has a journal entry for today, no need to nudge.
    if (userContexts.every((c) => journaledTrips.has(c.tripId))) {
      skipped++;
      continue;
    }

    const user = await pb.collection("users").getOne(userId, { $autoCancel: false });
    if (user.last_travel_notif_evening) {
      const last = ymd(user.last_travel_notif_evening);
      if (last === today) {
        skipped++;
        continue;
      }
    }

    const primary = userContexts.find((c) => !journaledTrips.has(c.tripId)) ?? userContexts[0];

    await sendPushToUser(pb, userId, {
      title: `How was today in ${primary.tripDestination}?`,
      body: "Tap to record what you'll want to remember.",
      url: tripUrl(primary.tripId),
      data: { type: "travel_evening", tripId: primary.tripId },
    }, { preferredOrigins: TRAVEL_ORIGINS });

    await pb.collection("users").update(userId, {
      last_travel_notif_evening: new Date().toISOString(),
    }, { $autoCancel: false });

    notified++;
  }

  console.log(`[travel-evening] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}
