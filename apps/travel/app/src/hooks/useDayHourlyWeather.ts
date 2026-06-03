import { useEffect, useMemo, useState } from "react";
import { getApiBase, getAuthHeaders } from "@kirkl/shared";

/**
 * One hourly weather record from GET /fn/travel/weather/hourly. Mirrors the
 * API's HourlyForecast: `time` is the local `HH:MM`, fields are null-tolerant.
 */
export interface HourlyForecast {
  time: string; // HH:MM (local)
  tempF: number | null;
  weatherCode: number | null;
  precipMm: number | null;
  precipProbability: number | null;
}

export interface UseDayHourlyWeather {
  hours: HourlyForecast[];
  loading: boolean;
  error: string | null;
  /** Nearest-hour lookup for a slot's "HH:MM" start time; null if no match. */
  pickHour: (hhmm: string | null | undefined) => HourlyForecast | null;
}

/**
 * Pick the hourly record nearest to `hhmm` ("HH:MM"). Mirrors the server-side
 * `pickHour` in weather.ts: rounds to the nearest whole hour, ties round down,
 * falls back to the chronologically closest entry if the exact hour is absent.
 */
function pickNearest(hours: HourlyForecast[], hhmm: string | null | undefined): HourlyForecast | null {
  if (!hhmm || hours.length === 0) return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const targetHour = min > 30 ? h + 1 : h;
  const targetHH = String(Math.min(targetHour, 23)).padStart(2, "0");
  const exact = hours.find((x) => x.time.slice(0, 2) === targetHH);
  if (exact) return exact;
  const targetMinutes = h * 60 + min;
  let best: HourlyForecast | null = null;
  let bestDist = Infinity;
  for (const x of hours) {
    const hm = x.time.match(/^(\d{2}):(\d{2})$/);
    if (!hm) continue;
    const dist = Math.abs(Number(hm[1]) * 60 + Number(hm[2]) - targetMinutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = x;
    }
  }
  return best;
}

/**
 * Fetch the hourly weather for a single trip day. Best-effort: errors and
 * missing data degrade to an empty `hours[]`, and the returned `pickHour`
 * helper yields null when no hour matches — callers render nothing in that
 * case. Mirrors the fetch/cancel pattern in useTripWeather.
 */
export function useDayHourlyWeather(
  tripId: string | undefined,
  date: string | undefined,
): UseDayHourlyWeather {
  const [hours, setHours] = useState<HourlyForecast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId || !date) {
      setHours([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = `tripId=${encodeURIComponent(tripId)}&date=${encodeURIComponent(date)}`;
    fetch(`${getApiBase()}/travel/weather/hourly?${qs}`, { headers: getAuthHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Hourly weather request failed (${res.status})`);
        return res.json() as Promise<{ hours?: HourlyForecast[] }>;
      })
      .then((resp) => {
        if (!cancelled) setHours(resp.hours ?? []);
      })
      .catch((e) => {
        if (!cancelled) {
          setHours([]);
          setError(e instanceof Error ? e.message : "Failed to load hourly weather");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, date]);

  const pickHour = useMemo(
    () => (hhmm: string | null | undefined) => pickNearest(hours, hhmm),
    [hours],
  );

  return { hours, loading, error, pickHour };
}
