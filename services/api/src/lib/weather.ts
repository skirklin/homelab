/**
 * Weather forecast + rule-based packing hints for a trip.
 *
 * Data source: Open-Meteo (free, no API key, no quota). This deliberately
 * does NOT touch Google — the geocode path here uses Open-Meteo's free
 * geocoding API as a last resort, and prefers a coordinate already stored on
 * a trip activity. No paid quota is consumed by this feature.
 *
 * Date handling: trip start/end are stored as date-only UTC instants
 * (`YYYY-MM-DDT00:00:00.000Z`). The canonical reduction to a calendar day is
 * the UTC date portion (`.slice(0,10)`) — the same rule the server gate and
 * the travel adapter use. `tripDateOnly` is the single reduction here; we do
 * NOT introduce a tz-local reduction.
 *
 * Everything in this module except `fetchOpenMeteo` / `geocodeDestination` is
 * pure and unit-tested directly.
 */

// Open-Meteo daily forecast horizon. Beyond this it returns no data, so we
// surface a "not yet available" state rather than fabricate.
export const FORECAST_HORIZON_DAYS = 16;

export interface DailyForecast {
  date: string; // YYYY-MM-DD
  tempMaxF: number | null;
  tempMinF: number | null;
  precipMm: number | null;
  precipProbabilityMax: number | null; // 0..100
  windMphMax: number | null;
  uvIndexMax: number | null;
}

export type ForecastWindow =
  | { state: "available"; start: string; end: string }
  | { state: "not_yet"; availableFrom: string } // T-16 date for the trip start
  | { state: "past" }
  | { state: "unknown_dates" };

// --- Date helpers -----------------------------------------------------------

/**
 * Reduce a stored trip date to its calendar day (YYYY-MM-DD), using the UTC
 * date portion — the canonical reduction (mirrors `start_date.slice(0,10)`
 * and the travel adapter's `utcYmd`). Accepts a bare `YYYY-MM-DD` too.
 */
export function tripDateOnly(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Bare date or full instant: the first 10 chars are the UTC calendar day in
  // both `2026-06-02` and `2026-06-02T00:00:00.000Z`. Validate via Date so we
  // don't pass through garbage.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Today's calendar day in UTC, as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Add `days` calendar days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Decide whether a forecast is available for the trip and, if so, what
 * calendar range to request from Open-Meteo.
 *
 * Rules:
 *  - No dates           → unknown_dates
 *  - Trip already ended → past
 *  - Trip starts beyond today + HORIZON → not_yet (with the T-16 date)
 *  - Otherwise          → available, with start clamped up to today and end
 *                         clamped down to the horizon (today + HORIZON).
 */
export function resolveForecastWindow(
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
  today: string = todayUtc(),
): ForecastWindow {
  const start = tripDateOnly(startRaw);
  const end = tripDateOnly(endRaw);
  if (!start && !end) return { state: "unknown_dates" };

  // A trip with only one date still works: treat a missing end as equal to
  // start (single-day) and a missing start as equal to end.
  const effStart = start ?? end!;
  const effEnd = end ?? start!;

  if (effEnd < today) return { state: "past" };

  const horizonEnd = addDays(today, FORECAST_HORIZON_DAYS);
  if (effStart > horizonEnd) {
    return { state: "not_yet", availableFrom: addDays(effStart, -FORECAST_HORIZON_DAYS) };
  }

  const clampedStart = effStart < today ? today : effStart;
  const clampedEnd = effEnd > horizonEnd ? horizonEnd : effEnd;
  return { state: "available", start: clampedStart, end: clampedEnd };
}

// --- Open-Meteo transform ---------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function roundOrNull(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/**
 * Zip Open-Meteo's parallel `daily.*` arrays into per-day records. Temps/wind
 * are rounded to whole units; UV keeps one decimal (it's a small index where
 * 6.4 vs 7 matters for the hint threshold). Null entries are tolerated.
 */
export function transformOpenMeteo(raw: unknown): DailyForecast[] {
  const daily = (raw as { daily?: Record<string, unknown[]> })?.daily;
  const time = daily?.time;
  if (!Array.isArray(time) || time.length === 0) return [];

  const col = (k: string): unknown[] => (Array.isArray(daily?.[k]) ? (daily![k] as unknown[]) : []);
  const tMax = col("temperature_2m_max");
  const tMin = col("temperature_2m_min");
  const precip = col("precipitation_sum");
  const precipProb = col("precipitation_probability_max");
  const wind = col("windspeed_10m_max");
  const uv = col("uv_index_max");

  return time.map((date, i) => ({
    date: String(date),
    tempMaxF: roundOrNull(tMax[i]),
    tempMinF: roundOrNull(tMin[i]),
    precipMm: num(precip[i]),
    precipProbabilityMax: roundOrNull(precipProb[i]),
    windMphMax: roundOrNull(wind[i]),
    // Keep one decimal of precision for UV so the >=7 threshold is honest.
    uvIndexMax: num(uv[i]),
  }));
}

// --- Packing hints (deterministic, threshold-based) -------------------------

/**
 * Derive packing-hint strings from the trip's daily forecast. Pure and
 * order-independent: a rule fires if ANY day across the trip crosses its
 * threshold. Thresholds are intentionally legible — see the activity-field
 * guide / the feature brief.
 */
export function derivePackingHints(days: DailyForecast[]): string[] {
  if (days.length === 0) return [];

  const hints: string[] = [];
  const vals = (pick: (d: DailyForecast) => number | null): number[] =>
    days.map(pick).filter((v): v is number => v !== null);

  const maxOf = (pick: (d: DailyForecast) => number | null): number | null => {
    const v = vals(pick);
    return v.length ? Math.max(...v) : null;
  };
  const minOf = (pick: (d: DailyForecast) => number | null): number | null => {
    const v = vals(pick);
    return v.length ? Math.min(...v) : null;
  };

  const maxPrecipProb = maxOf((d) => d.precipProbabilityMax);
  const minTemp = minOf((d) => d.tempMinF);
  const maxUv = maxOf((d) => d.uvIndexMax);
  const maxWind = maxOf((d) => d.windMphMax);
  const maxTemp = maxOf((d) => d.tempMaxF);

  if (maxPrecipProb !== null && maxPrecipProb >= 50) {
    hints.push("Packable rain shell / travel umbrella");
  }

  // Evening-layer rules are mutually exclusive — a cold trip gets the warm
  // layer, a cool-but-not-cold trip gets the light one. Never both.
  if (minTemp !== null) {
    if (minTemp <= 55) hints.push("Warm layer for evenings");
    else if (minTemp <= 62) hints.push("Light layer for evenings");
  }

  if (maxUv !== null && maxUv >= 7) {
    hints.push("Strong sunscreen, sunglasses, hat (high/clear-sky UV burns even when cool)");
  }

  if (maxWind !== null && maxWind >= 20) {
    hints.push("Wind layer");
  }

  if (maxTemp !== null && maxTemp >= 85) {
    hints.push("Hot/breathable clothing, stay hydrated");
  }

  if (maxTemp !== null && maxTemp <= 45) {
    hints.push("Cold-weather layers");
  }

  return hints;
}

// --- Network: Open-Meteo fetch + free geocoding -----------------------------

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

export interface Coord {
  lat: number;
  lon: number;
}

/**
 * Geocode a destination string via Open-Meteo's free geocoding API. No key,
 * no quota — deliberately NOT Google. Returns null if nothing matches.
 */
export async function geocodeDestination(
  destination: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Coord | null> {
  const q = destination.trim();
  if (!q) return null;
  // Open-Meteo geocoding matches on a single place name; strip a trailing
  // region/country qualifier (", AZ" / ", Mexico") to improve hit rate, but
  // try the full string first.
  const candidates = [q, q.split(",")[0]!.trim()].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const name of candidates) {
    const url = `${OPEN_METEO_GEOCODE}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) continue;
    const data = (await res.json()) as {
      results?: Array<{ latitude?: number; longitude?: number }>;
    };
    const hit = data.results?.[0];
    if (hit && typeof hit.latitude === "number" && typeof hit.longitude === "number") {
      return { lat: hit.latitude, lon: hit.longitude };
    }
  }
  return null;
}

/** Fetch the daily forecast for a coordinate + clamped date range (°F, mm). */
export async function fetchOpenMeteo(
  coord: Coord,
  start: string,
  end: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ days: DailyForecast[]; timezone: string }> {
  const params = new URLSearchParams({
    latitude: String(coord.lat),
    longitude: String(coord.lon),
    daily:
      "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,uv_index_max",
    timezone: "auto",
    temperature_unit: "fahrenheit",
    windspeed_unit: "mph",
    start_date: start,
    end_date: end,
  });
  const res = await fetchImpl(`${OPEN_METEO_FORECAST}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as { timezone?: string };
  return { days: transformOpenMeteo(raw), timezone: raw.timezone || "auto" };
}

// --- In-memory cache --------------------------------------------------------

interface CacheEntry {
  at: number;
  value: { days: DailyForecast[]; timezone: string };
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h — Open-Meteo daily data is stable.
const cache = new Map<string, CacheEntry>();

function cacheKey(coord: Coord, start: string, end: string): string {
  // Round coords to ~1km so trivially-different coords share a cache slot.
  return `${coord.lat.toFixed(2)},${coord.lon.toFixed(2)}:${start}:${end}`;
}

/**
 * Cached Open-Meteo fetch keyed by (lat, lon, date-range). TTL ~2h. Keeps the
 * free API from being hit on every panel render.
 */
export async function fetchOpenMeteoCached(
  coord: Coord,
  start: string,
  end: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ days: DailyForecast[]; timezone: string }> {
  const key = cacheKey(coord, start, end);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fetchOpenMeteo(coord, start, end, fetchImpl);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test seam — clear the module-level forecast cache. */
export function _clearWeatherCache(): void {
  cache.clear();
}
