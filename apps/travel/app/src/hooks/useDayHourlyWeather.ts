import { useEffect, useMemo, useState } from "react";
import { getApiBase, getAuthHeaders } from "@kirkl/shared";
import { parseSlotTime } from "../time";

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
  byActivity: Record<string, HourlyForecast[]>;
  loading: boolean;
  error: string | null;
  /**
   * Weather at a given activity's location for its slot start time. Returns
   * null when the activity has no coords, no forecast, or an unparseable time.
   */
  pickForActivity: (activityId: string, startTime: string | null | undefined) => HourlyForecast | null;
}

/**
 * Pick the hourly record nearest to a minutes-since-midnight target. Rounds to
 * the nearest whole hour (ties round down), falling back to the chronologically
 * closest entry when the exact hour is absent. Mirrors the server-side pickHour.
 */
function pickNearest(hours: HourlyForecast[], targetMinutes: number | null): HourlyForecast | null {
  if (targetMinutes == null || hours.length === 0) return null;
  const h = Math.floor(targetMinutes / 60);
  const min = targetMinutes % 60;
  const targetHour = min > 30 ? h + 1 : h;
  const targetHH = String(Math.min(targetHour, 23)).padStart(2, "0");
  const exact = hours.find((x) => x.time.slice(0, 2) === targetHH);
  if (exact) return exact;
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
 * Fetch per-activity-location hourly weather for a single trip day. Each
 * activity is forecast at its OWN coordinate, so a day spanning timezones
 * renders each slot against its own local hours. Best-effort: errors and
 * missing data degrade to empty results, and `pickForActivity` yields null
 * when nothing matches. Mirrors the fetch/cancel pattern in useTripWeather.
 */
export function useDayHourlyWeather(
  tripId: string | undefined,
  date: string | undefined,
  activityIds: string[],
): UseDayHourlyWeather {
  const [byActivity, setByActivity] = useState<Record<string, HourlyForecast[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable, order-independent key so the effect doesn't refire on array
  // identity churn or reordering.
  const idsKey = useMemo(() => [...activityIds].sort().join(","), [activityIds]);

  useEffect(() => {
    if (!tripId || !date || idsKey === "") {
      setByActivity({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = `tripId=${encodeURIComponent(tripId)}&date=${encodeURIComponent(date)}&activityIds=${encodeURIComponent(idsKey)}`;
    fetch(`${getApiBase()}/travel/weather/hourly?${qs}`, { headers: getAuthHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Hourly weather request failed (${res.status})`);
        return res.json() as Promise<{ byActivity?: Record<string, HourlyForecast[]> }>;
      })
      .then((resp) => {
        if (!cancelled) setByActivity(resp.byActivity ?? {});
      })
      .catch((e) => {
        if (!cancelled) {
          setByActivity({});
          setError(e instanceof Error ? e.message : "Failed to load hourly weather");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, date, idsKey]);

  const pickForActivity = useMemo(
    () => (activityId: string, startTime: string | null | undefined) =>
      pickNearest(byActivity[activityId] ?? [], parseSlotTime(startTime)),
    [byActivity],
  );

  return { byActivity, loading, error, pickForActivity };
}
