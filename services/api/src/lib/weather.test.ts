/**
 * Unit tests for the pure weather/packing-hints logic. No PB, no network —
 * exercises date reduction, the forecast-availability window, the Open-Meteo
 * response transform, and the deterministic packing-rule thresholds directly.
 */
import { describe, it, expect } from "vitest";
import {
  tripDateOnly,
  resolveForecastWindow,
  transformOpenMeteo,
  derivePackingHints,
  type DailyForecast,
} from "./weather";

describe("tripDateOnly", () => {
  it("reduces a stored UTC-midnight instant to its calendar day with no tz shift", () => {
    // This is the canonical reduction the server gate uses (start_date.slice(0,10)).
    expect(tripDateOnly("2026-06-02T00:00:00.000Z")).toBe("2026-06-02");
  });

  it("takes the UTC date portion, never a local reduction", () => {
    // An instant late on the 2nd in UTC is still the 2nd, even though it is
    // the 1st in US timezones. We must NOT reduce through local time.
    expect(tripDateOnly("2026-06-02T23:30:00.000Z")).toBe("2026-06-02");
  });

  it("passes through a bare YYYY-MM-DD string", () => {
    expect(tripDateOnly("2026-06-07")).toBe("2026-06-07");
  });

  it("returns null for empty/missing input", () => {
    expect(tripDateOnly("")).toBeNull();
    expect(tripDateOnly(undefined)).toBeNull();
    expect(tripDateOnly(null)).toBeNull();
  });
});

describe("resolveForecastWindow", () => {
  const today = "2026-06-01";

  it("returns available with a clamped range for an in-horizon upcoming trip", () => {
    const w = resolveForecastWindow("2026-06-02", "2026-06-07", today);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    // Start clamps to today (forecast shows from now forward, not before).
    expect(w.start).toBe("2026-06-02");
    expect(w.end).toBe("2026-06-07");
  });

  it("clamps a start that is in the past up to today", () => {
    // Trip started yesterday but is ongoing — show from today forward.
    const w = resolveForecastWindow("2026-05-30", "2026-06-04", today);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    expect(w.start).toBe("2026-06-01");
    expect(w.end).toBe("2026-06-04");
  });

  it("clamps an end beyond the 16-day horizon down to the horizon", () => {
    // Trip starts in-window but runs long.
    const w = resolveForecastWindow("2026-06-10", "2026-06-30", today);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    expect(w.start).toBe("2026-06-10");
    // today + 16 days = 2026-06-17
    expect(w.end).toBe("2026-06-17");
  });

  it("returns not_yet for a trip starting beyond the horizon", () => {
    const w = resolveForecastWindow("2026-10-15", "2026-10-20", today);
    expect(w.state).toBe("not_yet");
  });

  it("returns past for a trip that already ended", () => {
    const w = resolveForecastWindow("2026-05-01", "2026-05-05", today);
    expect(w.state).toBe("past");
  });

  it("returns unknown_dates when the trip has no dates", () => {
    const w = resolveForecastWindow(null, null, today);
    expect(w.state).toBe("unknown_dates");
  });
});

describe("transformOpenMeteo", () => {
  it("zips the parallel daily arrays into per-day records, rounding numerics", () => {
    const raw = {
      daily: {
        time: ["2026-06-02", "2026-06-03"],
        temperature_2m_max: [82.4, 90.1],
        temperature_2m_min: [60.6, 64.2],
        precipitation_sum: [0, 3.4],
        precipitation_probability_max: [10, 55],
        windspeed_10m_max: [8.2, 22.7],
        uv_index_max: [6.4, 8.1],
      },
    };
    const days = transformOpenMeteo(raw);
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({
      date: "2026-06-02",
      tempMaxF: 82,
      tempMinF: 61,
      precipMm: 0,
      precipProbabilityMax: 10,
      windMphMax: 8,
      uvIndexMax: 6.4,
    });
    expect(days[1].precipProbabilityMax).toBe(55);
    expect(days[1].uvIndexMax).toBe(8.1);
  });

  it("returns an empty array when daily is missing", () => {
    expect(transformOpenMeteo({})).toEqual([]);
    expect(transformOpenMeteo({ daily: {} })).toEqual([]);
  });

  it("tolerates null entries from the API (keeps the day, nulls the field)", () => {
    const raw = {
      daily: {
        time: ["2026-06-02"],
        temperature_2m_max: [null],
        temperature_2m_min: [55],
        precipitation_sum: [null],
        precipitation_probability_max: [null],
        windspeed_10m_max: [null],
        uv_index_max: [null],
      },
    };
    const days = transformOpenMeteo(raw);
    expect(days[0].tempMaxF).toBeNull();
    expect(days[0].tempMinF).toBe(55);
    expect(days[0].precipProbabilityMax).toBeNull();
  });
});

describe("derivePackingHints", () => {
  function day(over: Partial<DailyForecast>): DailyForecast {
    return {
      date: "2026-06-02",
      tempMaxF: 72,
      tempMinF: 65,
      precipMm: 0,
      precipProbabilityMax: 0,
      windMphMax: 5,
      uvIndexMax: 3,
      ...over,
    };
  }

  it("returns no hints for a mild, dry, calm day", () => {
    expect(derivePackingHints([day({})])).toEqual([]);
  });

  it("suggests rain gear when any day has >=50% precip probability", () => {
    const hints = derivePackingHints([day({ precipProbabilityMax: 50 })]);
    expect(hints.some((h) => /rain/i.test(h))).toBe(true);
  });

  it("suggests a warm layer when min temp <= 55", () => {
    const hints = derivePackingHints([day({ tempMinF: 50 })]);
    expect(hints.some((h) => /warm layer/i.test(h))).toBe(true);
  });

  it("suggests only a light layer between 56 and 62", () => {
    const hints = derivePackingHints([day({ tempMinF: 60 })]);
    expect(hints.some((h) => /light layer/i.test(h))).toBe(true);
    expect(hints.some((h) => /warm layer/i.test(h))).toBe(false);
  });

  it("does not double-suggest both warm and light layers", () => {
    const hints = derivePackingHints([day({ tempMinF: 40 })]);
    const layerHints = hints.filter((h) => /layer for evenings/i.test(h));
    expect(layerHints).toHaveLength(1);
  });

  it("suggests sun protection when UV >= 7", () => {
    const hints = derivePackingHints([day({ uvIndexMax: 8 })]);
    expect(hints.some((h) => /sunscreen/i.test(h))).toBe(true);
  });

  it("suggests a wind layer when wind >= 20 mph", () => {
    const hints = derivePackingHints([day({ windMphMax: 25 })]);
    expect(hints.some((h) => /wind/i.test(h))).toBe(true);
  });

  it("suggests hot-weather gear when max temp >= 85", () => {
    const hints = derivePackingHints([day({ tempMaxF: 90 })]);
    expect(hints.some((h) => /hydrated|breathable/i.test(h))).toBe(true);
  });

  it("suggests cold-weather layers when max temp <= 45", () => {
    const hints = derivePackingHints([day({ tempMaxF: 40, tempMinF: 30 })]);
    expect(hints.some((h) => /cold-weather/i.test(h))).toBe(true);
  });

  it("evaluates rules across the whole trip, not just one day", () => {
    const hints = derivePackingHints([
      day({ tempMaxF: 70, precipProbabilityMax: 10 }),
      day({ tempMaxF: 88, precipProbabilityMax: 70 }),
    ]);
    expect(hints.some((h) => /rain/i.test(h))).toBe(true);
    expect(hints.some((h) => /hydrated|breathable/i.test(h))).toBe(true);
  });

  it("returns an empty list for an empty forecast", () => {
    expect(derivePackingHints([])).toEqual([]);
  });
});
