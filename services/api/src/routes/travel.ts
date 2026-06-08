/**
 * Travel feature endpoints (distinct from the MCP/data CRUD in routes/data.ts).
 *
 * GET /weather?tripId=<id>
 *   Per-day weather for the WHOLE trip span + rule-based packing hints.
 *   Upcoming days come from the live forecast; past days from recorded
 *   actuals persisted in the `travel_weather` collection (backfilled from
 *   Open-Meteo's forecast/archive APIs the first time the panel is opened for
 *   a past day, then served from PB forever after). Each `forecast[]` day
 *   carries a `source: "actual" | "forecast"` tag.
 *   Source: Open-Meteo (free, no key, no quota — deliberately NOT Google, the
 *   geocode path uses Open-Meteo's free geocoder or a coord already stored on
 *   a trip activity). Mounted at /travel, so the public path is /fn/travel/weather.
 *
 * GET /weather/hourly?tripId=<id>&date=YYYY-MM-DD
 *   Hourly weather for a single trip day, used to show a per-activity
 *   time-of-day indicator in the day view. Best-effort: no persistence, no
 *   fabrication beyond the horizon, and a transient Open-Meteo failure
 *   degrades to an empty `hours[]` rather than a 500.
 *
 * Single trip-level coordinate. Persistence is superuser-only (getAdminPb);
 * clients only ever read.
 */
import { Hono } from "hono";
import { handler } from "../lib/handler";
import type { AppEnv } from "../index";
import { userOwnsTravelLog } from "../lib/authz";
import { getAdminPb } from "../lib/pb";
import {
  resolveForecastWindow,
  fetchOpenMeteo,
  fetchOpenMeteoArchive,
  fetchOpenMeteoCached,
  fetchOpenMeteoHourly,
  fetchOpenMeteoHourlyCached,
  geocodeDestination,
  derivePackingHints,
  mergeTripForecast,
  tripDateOnly,
  todayPacific,
  addDays,
  FORECAST_HORIZON_DAYS,
  groupActivitiesByCoord,
  type Coord,
  type DailyForecast,
  type HourlyForecast,
  type WeatherActivity,
} from "../lib/weather";

export const travelRoutes = new Hono<AppEnv>();

/**
 * Resolve a single coordinate for the trip. Preference order (cheapest first):
 *  1. A geocoded activity already on the trip (lat/lng stored, no network).
 *  2. The trip destination string via Open-Meteo's free geocoder.
 * Returns the coord plus the source for diagnostics.
 */
async function resolveTripCoord(
  pb: import("pocketbase").default,
  trip: { id: string; log: string; destination: string },
): Promise<{ coord: Coord; source: "activity" | "geocode" } | null> {
  // 1. Stored activity coordinate. Centroid is overkill for v1 — the first
  //    geocoded non-flight activity is a fine single anchor for the trip.
  try {
    const activities = await pb.collection("travel_activities").getFullList({
      filter: pb.filter("trip_id = {:tripId}", { tripId: trip.id }),
    });
    for (const a of activities) {
      const lat = a.lat as unknown;
      const lng = a.lng as unknown;
      if (
        typeof lat === "number" && Number.isFinite(lat) && lat !== 0 &&
        typeof lng === "number" && Number.isFinite(lng) && lng !== 0 &&
        a.category !== "Flight"
      ) {
        return { coord: { lat, lon: lng }, source: "activity" };
      }
    }
  } catch {
    // Fall through to geocode.
  }

  // 2. Geocode the destination string (free, no Google).
  if (trip.destination) {
    const coord = await geocodeDestination(trip.destination);
    if (coord) return { coord, source: "geocode" };
  }
  return null;
}

/** Enumerate the trip's calendar days [start..end] inclusive (YYYY-MM-DD). */
function tripDateList(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

travelRoutes.get("/weather", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const tripId = c.req.query("tripId");
  if (!tripId) return c.json({ error: "tripId required" }, 400);

  const trip = await pb.collection("travel_trips").getOne(tripId).catch(() => null);
  if (!trip) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, trip.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  // Date handling: trip dates are date-only UTC instants; reduce via the
  // canonical UTC-date rule (no tz shift). `today` is the Pacific calendar day.
  const start = tripDateOnly(trip.start_date as string | undefined);
  const end = tripDateOnly(trip.end_date as string | undefined);
  const today = todayPacific();

  if (!start && !end) {
    return c.json({
      tripId,
      destination: trip.destination,
      state: "unknown_dates",
      forecast: [],
      packingHints: [],
    });
  }

  // Open-ended start (start, no end) → a useful ~7-day window, mirroring
  // resolveForecastWindow. A trip with only an end uses that end for both.
  const effStart = start ?? end!;
  const effEnd = end ?? (start ? addDays(start, 6) : end!);
  const tripDates = tripDateList(effStart, effEnd);

  const resolved = await resolveTripCoord(pb, {
    id: trip.id,
    log: trip.log as string,
    destination: trip.destination as string,
  });
  if (!resolved) {
    return c.json({
      tripId,
      destination: trip.destination,
      state: "no_location",
      forecast: [],
      packingHints: [],
    });
  }
  const { coord } = resolved;

  // 4. Persisted actuals for this trip (owner-scoped read).
  const actuals = new Map<string, DailyForecast>();
  try {
    const rows = await pb.collection("travel_weather").getFullList({
      filter: pb.filter("trip = {:tripId}", { tripId: trip.id }),
    });
    for (const r of rows) {
      actuals.set(r.date as string, {
        date: r.date as string,
        tempMaxF: (r.tempMaxF as number) ?? null,
        tempMinF: (r.tempMinF as number) ?? null,
        precipMm: (r.precipMm as number) ?? null,
        precipProbabilityMax: (r.precipProbabilityMax as number) ?? null,
        windMphMax: (r.windMphMax as number) ?? null,
        uvIndexMax: (r.uvIndexMax as number) ?? null,
        weatherCode: (r.weatherCode as number) ?? null,
      });
    }
  } catch {
    // No persisted actuals yet — proceed with an empty map.
  }

  // 5. Backfill missing PAST days (< today, not already persisted). Split by
  //    age: recent past (>= today-5) is served by the forecast API; older
  //    past goes through the archive API (which lags a few days).
  const archiveCutoff = addDays(today, -5);
  const missingPast = tripDates.filter((d) => d < today && !actuals.has(d));
  const recentPast = missingPast.filter((d) => d >= archiveCutoff);
  const olderPast = missingPast.filter((d) => d < archiveCutoff);

  const backfill = async (
    subset: string[],
    fetcher: (co: Coord, s: string, e: string) => Promise<{ days: DailyForecast[] }>,
  ) => {
    if (subset.length === 0) return;
    const min = subset[0];
    const max = subset[subset.length - 1];
    try {
      const { days } = await fetcher(coord, min, max);
      const wanted = new Set(subset);
      const admin = await getAdminPb();
      const capturedAt = new Date().toISOString();
      for (const day of days) {
        if (!wanted.has(day.date)) continue;
        const record = { ...day, source: "actual" as const };
        actuals.set(day.date, record);
        try {
          await admin.collection("travel_weather").create({
            log: trip.log,
            trip: trip.id,
            date: day.date,
            tempMaxF: day.tempMaxF,
            tempMinF: day.tempMinF,
            precipMm: day.precipMm,
            precipProbabilityMax: day.precipProbabilityMax,
            windMphMax: day.windMphMax,
            uvIndexMax: day.uvIndexMax,
            weatherCode: day.weatherCode,
            source: "actual",
            lat: coord.lat,
            lon: coord.lon,
            capturedAt,
          });
        } catch {
          // Unique (trip,date) conflict or transient write error — the row is
          // already in `actuals` for this response, so just skip persistence.
        }
      }
    } catch {
      // Transient Open-Meteo failure — degrade gracefully, don't 500 the panel.
    }
  };

  // recentPast (>= today-5) is sorted ascending because tripDates is.
  await backfill(recentPast, (co, s, e) => fetchOpenMeteo(co, s, e));
  await backfill(olderPast, (co, s, e) => fetchOpenMeteoArchive(co, s, e));

  // 6. Live FUTURE forecast for [max(today,start) .. min(end, today+HORIZON)].
  const forecast = new Map<string, DailyForecast>();
  let timezone = "auto";
  const fcStart = effStart < today ? today : effStart;
  const horizonEnd = addDays(today, FORECAST_HORIZON_DAYS);
  const fcEnd = effEnd > horizonEnd ? horizonEnd : effEnd;
  if (fcStart <= fcEnd) {
    try {
      const res = await fetchOpenMeteoCached(coord, fcStart, fcEnd);
      timezone = res.timezone;
      for (const day of res.days) forecast.set(day.date, day);
    } catch {
      // Transient — fall through with whatever actuals we have.
    }
  }

  // 7. Merge persisted actuals + live forecast over the whole trip span.
  const days = mergeTripForecast(tripDates, actuals, forecast);

  // Empty span: distinguish "trip starts beyond the forecast horizon" (we'll
  // have data later) from a genuine no-data state.
  if (days.length === 0) {
    const window = resolveForecastWindow(
      trip.start_date as string | undefined,
      trip.end_date as string | undefined,
      today,
    );
    if (window.state === "not_yet") {
      return c.json({
        tripId,
        destination: trip.destination,
        state: "not_yet",
        availableFrom: window.availableFrom,
        forecast: [],
        packingHints: [],
      });
    }
    return c.json({
      tripId,
      destination: trip.destination,
      state: "available",
      location: { lat: coord.lat, lon: coord.lon, source: resolved.source, timezone },
      forecast: [],
      packingHints: [],
    });
  }

  // Packing hints are forward-looking only — past days don't inform packing.
  const packingHints = derivePackingHints(days.filter((d) => d.date >= today));

  return c.json({
    tripId,
    destination: trip.destination,
    state: "available",
    location: { lat: coord.lat, lon: coord.lon, source: resolved.source, timezone },
    forecast: days,
    packingHints,
  });
}));

travelRoutes.get("/weather/hourly", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const tripId = c.req.query("tripId");
  const date = c.req.query("date");
  const activityIdsParam = c.req.query("activityIds");
  if (!tripId) return c.json({ error: "tripId required" }, 400);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "valid date (YYYY-MM-DD) required" }, 400);
  }

  const trip = await pb.collection("travel_trips").getOne(tripId).catch(() => null);
  if (!trip) return c.json({ error: "not found" }, 404);
  if (!(await userOwnsTravelLog(pb, trip.log as string, userId))) {
    return c.json({ error: "access denied" }, 403);
  }

  // Beyond the forecast horizon AND in the future → no data exists yet; don't
  // fabricate. (Past dates are always fetchable via forecast/archive.)
  const today = todayPacific();
  const beyondHorizon = date > addDays(today, FORECAST_HORIZON_DAYS);

  // --- Per-activity-location mode -------------------------------------------
  // Each activity gets weather at its OWN coordinate, so a day that spans
  // timezones renders each slot against its own local hours. Coords are
  // fetched once per distinct location (timezone=auto per fetch — never batch
  // coords under a shared tz).
  if (activityIdsParam !== undefined) {
    const ids = activityIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return c.json({ date, byActivity: {} });
    if (beyondHorizon) return c.json({ date, byActivity: {}, state: "not_yet" });

    // Resolve each requested activity and verify it belongs to this trip.
    const activities: WeatherActivity[] = [];
    await Promise.all(ids.map(async (id) => {
      const a = await pb.collection("travel_activities").getOne(id).catch(() => null);
      if (a && a.trip_id === trip.id) {
        activities.push({ id: a.id, lat: a.lat as number | null, lng: a.lng as number | null });
      }
    }));

    const { coords, activityToKey } = groupActivitiesByCoord(activities);

    // Fetch each distinct coord once (cached), degrade per-coord on failure.
    const hoursByKey = new Map<string, HourlyForecast[]>();
    await Promise.all(coords.map(async ({ key, coord }) => {
      try {
        const { hours } = await fetchOpenMeteoHourlyCached(coord, date);
        hoursByKey.set(key, hours);
      } catch {
        hoursByKey.set(key, []);
      }
    }));

    const byActivity: Record<string, HourlyForecast[]> = {};
    for (const [activityId, key] of activityToKey) {
      byActivity[activityId] = hoursByKey.get(key) ?? [];
    }
    return c.json({ date, byActivity });
  }

  // --- Legacy trip-level mode (single trip coord) ---------------------------
  const resolved = await resolveTripCoord(pb, {
    id: trip.id,
    log: trip.log as string,
    destination: trip.destination as string,
  });
  if (!resolved) return c.json({ date, hours: [] });

  if (beyondHorizon) {
    return c.json({ date, hours: [], state: "not_yet" });
  }

  try {
    const { hours, timezone } = await fetchOpenMeteoHourly(resolved.coord, date);
    return c.json({ date, timezone, hours });
  } catch {
    // Transient Open-Meteo failure — degrade gracefully, don't 500 the view.
    return c.json({ date, hours: [] });
  }
}));
