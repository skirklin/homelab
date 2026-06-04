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
  transformOpenMeteoHourly,
  pickHour,
  fetchOpenMeteoArchive,
  fetchOpenMeteoHourly,
  mergeTripForecast,
  derivePackingHints,
  todayPacific,
  type DailyForecast,
  type HourlyForecast,
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

  it("extends an open-ended trip (empty end_date) to a ~7-day window", () => {
    // A trip with a start but no end (e.g. Isle Royale) should show a useful
    // multi-day window, not collapse to a single day.
    const w = resolveForecastWindow("2026-06-05", "", today);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    expect(w.start).toBe("2026-06-05");
    // start + 6 days, still inside the horizon.
    expect(w.end).toBe("2026-06-11");
  });

  it("clamps an open-ended trip's default window down to the horizon", () => {
    // Start is in-window but start + 6 days would exceed the 16-day horizon.
    const w = resolveForecastWindow("2026-06-15", "", today);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    expect(w.start).toBe("2026-06-15");
    // today + 16 = 2026-06-17, which is before start + 6 (2026-06-21).
    expect(w.end).toBe("2026-06-17");
  });
});

describe("todayPacific", () => {
  it("reduces a UTC instant to the Pacific calendar day, not the UTC day", () => {
    // 2026-06-01T05:30:00Z = 2026-05-31 22:30 PDT. Pacific day is the 31st even
    // though the UTC day has already rolled to June 1st. This is the exact
    // ~5pm–midnight PT window where a naive UTC reduction reads a day ahead.
    expect(todayPacific(new Date("2026-06-01T05:30:00.000Z"))).toBe("2026-05-31");
  });

  it("agrees with the UTC day during PT daytime", () => {
    // 2026-06-01T20:00:00Z = 2026-06-01 13:00 PDT — same calendar day both ways.
    expect(todayPacific(new Date("2026-06-01T20:00:00.000Z"))).toBe("2026-06-01");
  });
});

describe("resolveForecastWindow default today (Pacific-anchored)", () => {
  // The default `today` must be the Pacific calendar day, NOT the pod's UTC
  // day. We can't freeze the global clock cleanly, so we assert the contract
  // directly: the default param is `todayPacific()`, and passing that same
  // value explicitly classifies a trip ending on the Pacific-today date as
  // active rather than past. Under the old UTC default this trip would be
  // `past` for ~7h every evening.
  it("treats a trip ending on the Pacific-today date as available, not past", () => {
    const pacificToday = todayPacific(new Date("2026-06-01T05:30:00.000Z")); // 2026-05-31
    const w = resolveForecastWindow("2026-05-31", "2026-05-31", pacificToday);
    expect(w.state).toBe("available");
    if (w.state !== "available") throw new Error("expected available");
    expect(w.start).toBe("2026-05-31");
    expect(w.end).toBe("2026-05-31");
  });

  it("uses todayPacific() as the default reference day", () => {
    // No explicit `today` → must behave identically to passing todayPacific().
    expect(resolveForecastWindow(null, null)).toEqual(
      resolveForecastWindow(null, null, todayPacific()),
    );
    // And a trip far in the past is `past` regardless of the UTC/Pacific edge.
    expect(resolveForecastWindow("2020-01-01", "2020-01-02").state).toBe("past");
  });
});

describe("transformOpenMeteo", () => {
  it("zips the parallel daily arrays into per-day records, rounding numerics", () => {
    const raw = {
      daily: {
        time: ["2026-06-02", "2026-06-03"],
        weathercode: [0, 61],
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
      weatherCode: 0,
    });
    expect(days[1].precipProbabilityMax).toBe(55);
    expect(days[1].uvIndexMax).toBe(8.1);
  });

  it("carries the WMO weather code through, nulling a missing column", () => {
    const days = transformOpenMeteo({
      daily: {
        time: ["2026-06-02", "2026-06-03"],
        weathercode: [95, null],
        temperature_2m_max: [70, 72],
        temperature_2m_min: [55, 56],
      },
    });
    expect(days[0].weatherCode).toBe(95);
    expect(days[1].weatherCode).toBeNull();
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

describe("transformOpenMeteoHourly", () => {
  it("zips forecast-shaped hourly arrays, reducing ISO time to HH:MM and rounding temp", () => {
    const raw = {
      hourly: {
        time: ["2026-06-02T08:00", "2026-06-02T09:00"],
        temperature_2m: [58.4, 61.9],
        precipitation: [0, 0.3],
        precipitation_probability: [10, 40],
        weathercode: [3, 61],
      },
    };
    const hours = transformOpenMeteoHourly(raw);
    expect(hours).toHaveLength(2);
    expect(hours[0]).toEqual({
      time: "08:00",
      tempF: 58,
      weatherCode: 3,
      precipMm: 0,
      precipProbability: 10,
    });
    expect(hours[1]).toEqual({
      time: "09:00",
      tempF: 62,
      weatherCode: 61,
      precipMm: 0.3,
      precipProbability: 40,
    });
  });

  it("nulls precipProbability for archive-shaped hourly (no such column)", () => {
    const raw = {
      hourly: {
        time: ["2026-05-01T12:00"],
        temperature_2m: [70.2],
        precipitation: [1.1],
        // no precipitation_probability column on the archive API
        weathercode: [80],
      },
    };
    const hours = transformOpenMeteoHourly(raw);
    expect(hours[0].precipProbability).toBeNull();
    expect(hours[0].weatherCode).toBe(80);
    expect(hours[0].tempF).toBe(70);
    expect(hours[0].time).toBe("12:00");
  });

  it("returns an empty array when hourly is missing", () => {
    expect(transformOpenMeteoHourly({})).toEqual([]);
    expect(transformOpenMeteoHourly({ hourly: {} })).toEqual([]);
  });

  it("tolerates null entries (keeps the hour, nulls the field)", () => {
    const hours = transformOpenMeteoHourly({
      hourly: {
        time: ["2026-06-02T00:00"],
        temperature_2m: [null],
        precipitation: [null],
        precipitation_probability: [null],
        weathercode: [null],
      },
    });
    expect(hours[0]).toEqual({
      time: "00:00",
      tempF: null,
      weatherCode: null,
      precipMm: null,
      precipProbability: null,
    });
  });
});

describe("pickHour", () => {
  const hours: HourlyForecast[] = Array.from({ length: 24 }, (_, h) => ({
    time: `${String(h).padStart(2, "0")}:00`,
    tempF: h,
    weatherCode: 0,
    precipMm: 0,
    precipProbability: 0,
  }));

  it("matches an exact hour", () => {
    expect(pickHour(hours, "09:00")?.time).toBe("09:00");
  });

  it("rounds 09:30 down to 09:00 (ties round down)", () => {
    expect(pickHour(hours, "09:30")?.time).toBe("09:00");
  });

  it("rounds 09:31 up to 10:00", () => {
    expect(pickHour(hours, "09:31")?.time).toBe("10:00");
  });

  it("rounds 09:29 down to 09:00", () => {
    expect(pickHour(hours, "09:29")?.time).toBe("09:00");
  });

  it("returns null for empty hours", () => {
    expect(pickHour([], "09:00")).toBeNull();
  });

  it("returns null for a malformed time", () => {
    expect(pickHour(hours, "")).toBeNull();
    expect(pickHour(hours, "9am")).toBeNull();
    expect(pickHour(hours, "25:00")).toBeNull();
    expect(pickHour(hours, "12:99")).toBeNull();
  });

  it("falls back to the nearest available entry when the target hour is absent", () => {
    const sparse: HourlyForecast[] = [
      { time: "06:00", tempF: 50, weatherCode: 0, precipMm: 0, precipProbability: 0 },
      { time: "12:00", tempF: 70, weatherCode: 0, precipMm: 0, precipProbability: 0 },
    ];
    // 10:00 has no exact entry; 12:00 (120 min away) is closer than 06:00 (240 min).
    expect(pickHour(sparse, "10:00")?.time).toBe("12:00");
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
      weatherCode: 0,
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

describe("fetchOpenMeteoArchive", () => {
  // Archive-shaped payload: no precip-probability or UV columns, but weather
  // code + temps + precip + wind are present.
  const archivePayload = {
    timezone: "America/Denver",
    daily: {
      time: ["2026-05-01", "2026-05-02"],
      weathercode: [3, 80],
      temperature_2m_max: [68.3, 71.9],
      temperature_2m_min: [44.1, 48.6],
      precipitation_sum: [0, 2.1],
      windspeed_10m_max: [12.4, 9.8],
    },
  };

  function fakeFetch(): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => archivePayload,
        text: async () => "",
      }) as unknown as Response) as unknown as typeof fetch;
  }

  it("transforms archive data: present code/temps, null precipProb/uv", async () => {
    const { days, timezone } = await fetchOpenMeteoArchive(
      { lat: 39.7, lon: -104.99 },
      "2026-05-01",
      "2026-05-02",
      fakeFetch(),
    );
    expect(timezone).toBe("America/Denver");
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({
      date: "2026-05-01",
      tempMaxF: 68,
      tempMinF: 44,
      precipMm: 0,
      precipProbabilityMax: null,
      windMphMax: 12,
      uvIndexMax: null,
      weatherCode: 3,
    });
    expect(days[1].weatherCode).toBe(80);
    expect(days[1].precipProbabilityMax).toBeNull();
    expect(days[1].uvIndexMax).toBeNull();
  });
});

describe("fetchOpenMeteoHourly", () => {
  // Capture the URL passed to the injected fetch so we can assert which hourly
  // variables each branch requests.
  function capturingFetch(): { fetch: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ timezone: "America/Denver", hourly: { time: [] } }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fetch, urls };
  }

  it("omits precipitation_probability on the archive branch (unsupported there)", async () => {
    const { fetch, urls } = capturingFetch();
    // A date well in the past forces the archive branch (date < today-5).
    await fetchOpenMeteoHourly({ lat: 39.7, lon: -104.99 }, "2020-01-15", fetch);
    expect(urls).toHaveLength(1);
    const hourly = new URL(urls[0]).searchParams.get("hourly");
    expect(hourly).toBe("temperature_2m,precipitation,weathercode");
    expect(hourly).not.toContain("precipitation_probability");
  });

  it("includes precipitation_probability on the forecast branch", async () => {
    const { fetch, urls } = capturingFetch();
    // A date far in the future forces the forecast branch (date >= today-5).
    await fetchOpenMeteoHourly({ lat: 39.7, lon: -104.99 }, "2099-12-31", fetch);
    expect(urls).toHaveLength(1);
    const hourly = new URL(urls[0]).searchParams.get("hourly");
    expect(hourly).toBe("temperature_2m,precipitation,precipitation_probability,weathercode");
  });
});

describe("mergeTripForecast", () => {
  function fc(date: string, over: Partial<DailyForecast> = {}): DailyForecast {
    return {
      date,
      tempMaxF: 70,
      tempMinF: 50,
      precipMm: 0,
      precipProbabilityMax: 0,
      windMphMax: 5,
      uvIndexMax: 3,
      weatherCode: 0,
      ...over,
    };
  }

  it("prefers an actual over a forecast for the same date", () => {
    const dates = ["2026-06-01"];
    const actuals = new Map([["2026-06-01", fc("2026-06-01", { tempMaxF: 99 })]]);
    const forecast = new Map([["2026-06-01", fc("2026-06-01", { tempMaxF: 70 })]]);
    const out = mergeTripForecast(dates, actuals, forecast);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("actual");
    expect(out[0].tempMaxF).toBe(99);
  });

  it("falls back to a forecast when no actual exists", () => {
    const out = mergeTripForecast(
      ["2026-06-02"],
      new Map(),
      new Map([["2026-06-02", fc("2026-06-02")]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("forecast");
  });

  it("skips dates with neither actual nor forecast (no fabrication)", () => {
    const out = mergeTripForecast(
      ["2026-06-01", "2026-06-02", "2026-06-03"],
      new Map([["2026-06-01", fc("2026-06-01")]]),
      new Map([["2026-06-03", fc("2026-06-03")]]),
    );
    // 06-02 has no data → dropped.
    expect(out.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-03"]);
  });

  it("preserves the input date order and tags each day's source", () => {
    const dates = ["2026-06-01", "2026-06-02", "2026-06-03"];
    const actuals = new Map([["2026-06-01", fc("2026-06-01")]]);
    const forecast = new Map([
      ["2026-06-02", fc("2026-06-02")],
      ["2026-06-03", fc("2026-06-03")],
    ]);
    const out = mergeTripForecast(dates, actuals, forecast);
    expect(out.map((d) => d.date)).toEqual(dates);
    expect(out.map((d) => d.source)).toEqual(["actual", "forecast", "forecast"]);
  });
});
