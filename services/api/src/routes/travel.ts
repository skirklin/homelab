/**
 * Travel feature endpoints (distinct from the MCP/data CRUD in routes/data.ts).
 *
 * GET /weather?tripId=<id>
 *   Read-only weather forecast + rule-based packing hints for a trip.
 *   Source: Open-Meteo (free, no key, no quota — deliberately NOT Google, the
 *   geocode path uses Open-Meteo's free geocoder or a coord already stored on
 *   a trip activity). Mounted at /travel, so the public path is /fn/travel/weather.
 *
 * v1 is trip-level: a single coordinate for the whole trip. The response shape
 * (a `location` block + a flat `days[]`) leaves room for a future per-day /
 * per-location extension that follows the itinerary without breaking callers.
 */
import { Hono } from "hono";
import { handler } from "../lib/handler";
import type { AppEnv } from "../index";
import { userOwnsTravelLog } from "../lib/authz";
import {
  resolveForecastWindow,
  fetchOpenMeteoCached,
  geocodeDestination,
  derivePackingHints,
  type Coord,
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

  // Date handling: trip dates are date-only UTC instants; resolveForecastWindow
  // reduces them via the canonical UTC-date rule (no tz shift) and decides the
  // availability state + clamped request range.
  const window = resolveForecastWindow(
    trip.start_date as string | undefined,
    trip.end_date as string | undefined,
  );

  if (window.state !== "available") {
    // Not-yet / past / unknown-dates: return the state so the panel renders a
    // sensible message instead of fabricating data.
    return c.json({
      tripId,
      destination: trip.destination,
      state: window.state,
      ...(window.state === "not_yet" ? { availableFrom: window.availableFrom } : {}),
      forecast: [],
      packingHints: [],
    });
  }

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

  const { days, timezone } = await fetchOpenMeteoCached(resolved.coord, window.start, window.end);
  const packingHints = derivePackingHints(days);

  return c.json({
    tripId,
    destination: trip.destination,
    state: "available",
    location: {
      lat: resolved.coord.lat,
      lon: resolved.coord.lon,
      source: resolved.source,
      timezone,
    },
    range: { start: window.start, end: window.end },
    forecast: days,
    packingHints,
  });
}));
