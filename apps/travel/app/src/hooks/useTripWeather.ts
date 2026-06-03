import { useEffect, useState } from "react";
import { getApiBase, getAuthHeaders } from "@kirkl/shared";

/**
 * One per-day weather record from GET /fn/travel/weather. Mirrors the API's
 * DailyForecast plus the `source` tag the endpoint adds when merging the
 * trip span (actuals for past days, forecast for upcoming).
 */
export interface WeatherDay {
  date: string;
  tempMaxF: number | null;
  tempMinF: number | null;
  precipMm: number | null;
  precipProbabilityMax: number | null;
  windMphMax: number | null;
  uvIndexMax: number | null;
  weatherCode: number | null;
  source?: "actual" | "forecast";
}

export interface WeatherResponse {
  tripId: string;
  destination: string;
  state: "available" | "not_yet" | "unknown_dates" | "no_location";
  availableFrom?: string;
  location?: { lat: number; lon: number; source: string; timezone: string };
  forecast: WeatherDay[];
  packingHints: string[];
}

export interface UseTripWeather {
  data: WeatherResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetch the per-day weather span for a trip. Single source of truth shared by
 * the itinerary day cards, the day view, and the Prep-tab packing panel — the
 * API caches upstream so multiple mounts are cheap.
 */
export function useTripWeather(tripId: string | undefined): UseTripWeather {
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${getApiBase()}/travel/weather?tripId=${encodeURIComponent(tripId)}`, {
      headers: getAuthHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Forecast request failed (${res.status})`);
        return res.json() as Promise<WeatherResponse>;
      })
      .then((resp) => {
        if (!cancelled) setData(resp);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load forecast");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  return { data, loading, error };
}

/** Build a date → day lookup from a weather response (empty if no data). */
export function weatherByDate(data: WeatherResponse | null): Map<string, WeatherDay> {
  const m = new Map<string, WeatherDay>();
  for (const d of data?.forecast ?? []) m.set(d.date, d);
  return m;
}
