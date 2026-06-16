/**
 * useSelectedDate invariants — the subtle, easy-to-break part is the tz split:
 * the viewed day's IDENTITY is the user-tz `dayKey` and its representative
 * instant is user-tz NOON, while prev/next stepping uses DEVICE-local
 * `Date.setDate(±1)`. The combination must advance the user-tz day by exactly
 * one — never skip or repeat — even when the device tz differs from the user's
 * tz, and the `?date=` round-trip must be drift-free. These tests pin those
 * properties; do NOT relax the noon/dayKey logic to make them pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { dayKey } from "@homelab/backend";

// Pin the app's single tz source to a fixed user tz, independent of whatever
// the device/test clock is in. America/Los_Angeles is the running example
// because it has a clean DST transition and a large offset from the foreign
// device tz we simulate below.
const USER_TZ = "America/Los_Angeles";
vi.mock("./useUserTz", () => ({
  userTz: () => USER_TZ,
  useUserTz: () => USER_TZ,
}));

import {
  parseYmdParam,
  getDateString,
  startOfDay,
  useSelectedDate,
} from "./useSelectedDate";

// `dayKey(d, USER_TZ)` is exactly what getDateString computes — used here as an
// independent oracle so the assertions don't just compare a function to itself.
const userDayKey = (d: Date) => dayKey(d, USER_TZ);

function wrapper(initialUrl: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialUrl]}>{children}</MemoryRouter>
  );
}

// Restore the real device tz after each test that mutates it.
const REAL_TZ = process.env.TZ;
beforeEach(() => {
  process.env.TZ = REAL_TZ;
});
afterEach(() => {
  process.env.TZ = REAL_TZ;
});

describe("parseYmdParam ↔ getDateString round-trip", () => {
  it("round-trips a plain date stably", () => {
    const d = parseYmdParam("2026-06-10");
    expect(d).not.toBeNull();
    expect(getDateString(d!)).toBe("2026-06-10");
  });

  it("round-trips the US spring-forward (DST) day stably", () => {
    // 2026-03-08 is the US DST spring-forward day (02:00→03:00 PT). The noon
    // anchor sidesteps the missing hour, so the key must still be the same day.
    const d = parseYmdParam("2026-03-08");
    expect(d).not.toBeNull();
    expect(getDateString(d!)).toBe("2026-03-08");
  });

  it("round-trips the US fall-back (DST) day stably", () => {
    // 2025-11-02 is a fall-back day (the 01:00 hour repeats). Noon is
    // unambiguous, so the key is stable here too. (A past year: parseYmdParam
    // rejects dates beyond tomorrow, and the 2026 fall-back is still future.)
    const d = parseYmdParam("2025-11-02");
    expect(d).not.toBeNull();
    expect(getDateString(d!)).toBe("2025-11-02");
  });

  it("rejects an impossible calendar date (round-trip guard)", () => {
    // 2026-02-31 rolls into March; the internal round-trip check catches it.
    expect(parseYmdParam("2026-02-31")).toBeNull();
    expect(parseYmdParam("garbage")).toBeNull();
    expect(parseYmdParam(null)).toBeNull();
  });
});

describe("stepping advances the user-tz day by exactly one — even when device tz ≠ user tz", () => {
  // Simulate a device whose zone is far ahead of the user's (UTC+14 vs the
  // user's ~UTC-7/8). This is the configuration where naive device-local date
  // math could land the noon anchor on the wrong user-tz day.
  beforeEach(() => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, no DST
  });

  it("goToNextDay advances exactly one user-tz day with no skip/repeat", () => {
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-06-10"),
    });
    expect(getDateString(result.current.selectedDate)).toBe("2026-06-10");

    const seen: string[] = [userDayKey(result.current.selectedDate)];
    // Step forward up to (but not onto) today — canGoNext guards the upper edge.
    for (let i = 0; i < 5 && result.current.canGoNext; i++) {
      act(() => result.current.goToNextDay());
      seen.push(userDayKey(result.current.selectedDate));
    }
    // Each consecutive key differs by exactly one calendar day: no repeats,
    // no skips.
    for (let i = 1; i < seen.length; i++) {
      expect(dayGap(seen[i - 1], seen[i])).toBe(1);
    }
  });

  it("goToPrevDay retreats exactly one user-tz day with no skip/repeat", () => {
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-06-10"),
    });
    const seen: string[] = [userDayKey(result.current.selectedDate)];
    for (let i = 0; i < 5; i++) {
      act(() => result.current.goToPrevDay());
      seen.push(userDayKey(result.current.selectedDate));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(dayGap(seen[i], seen[i - 1])).toBe(1);
    }
    expect(seen).toEqual([
      "2026-06-10",
      "2026-06-09",
      "2026-06-08",
      "2026-06-07",
      "2026-06-06",
      "2026-06-05",
    ]);
  });

  it("stepping back then forward returns to the same user-tz day (no drift)", () => {
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-06-10"),
    });
    act(() => result.current.goToPrevDay());
    act(() => result.current.goToNextDay());
    expect(getDateString(result.current.selectedDate)).toBe("2026-06-10");
  });

  it("steps cleanly across the user-tz DST spring-forward boundary", () => {
    // Device still UTC+14; user-tz crosses 2026-03-08 (spring forward).
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-03-07"),
    });
    act(() => result.current.goToNextDay());
    expect(getDateString(result.current.selectedDate)).toBe("2026-03-08");
    act(() => result.current.goToNextDay());
    expect(getDateString(result.current.selectedDate)).toBe("2026-03-09");
  });
});

describe("getSelectedTimestamp() buckets into the selected user-tz day", () => {
  it("returns an instant whose user-tz dayKey matches the viewed day (foreign device tz)", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-06-10"),
    });
    const ts = result.current.getSelectedTimestamp();
    expect(ts).toBeInstanceOf(Date);
    // The backfill anchor must land in the SAME user-tz day the user picked,
    // so a backfilled event shows under the viewed day, not a neighbor.
    expect(userDayKey(ts!)).toBe("2026-06-10");
    expect(userDayKey(ts!)).toBe(getDateString(result.current.selectedDate));
  });

  it("returns undefined for today (today → log at now, not a backfilled noon)", () => {
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/"),
    });
    expect(result.current.isToday).toBe(true);
    expect(result.current.getSelectedTimestamp()).toBeUndefined();
  });
});

describe("?date= round-trip is stable (no drift / loop)", () => {
  it("an inbound ?date= is adopted verbatim into the viewed day", () => {
    const { result } = renderHook(() => useSelectedDate(), {
      wrapper: wrapper("/?date=2026-06-10"),
    });
    expect(getDateString(result.current.selectedDate)).toBe("2026-06-10");
    expect(result.current.dateParam).toBe("2026-06-10");
    expect(result.current.isToday).toBe(false);
  });

  it("parse → key → re-parse is a fixed point across a DST day (foreign device tz)", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    // This is the pure serialization round-trip the URL mirror relies on: the
    // key a Date serializes to must re-parse to a Date with that same key, or
    // the URL<->state reconcile could oscillate.
    for (const raw of ["2026-03-08", "2025-11-02", "2026-06-10"]) {
      const d1 = parseYmdParam(raw)!;
      const key = getDateString(d1);
      expect(key).toBe(raw);
      const d2 = parseYmdParam(key)!;
      expect(getDateString(d2)).toBe(raw);
    }
  });

  it("startOfDay(updateSelectedDate target) keeps the same user-tz day", () => {
    // updateSelectedDate routes a picked Date through startOfDay; the result's
    // user-tz key must equal the picked day's key (foreign device tz).
    process.env.TZ = "Pacific/Kiritimati";
    const picked = parseYmdParam("2026-06-10")!;
    expect(getDateString(startOfDay(picked))).toBe("2026-06-10");
  });
});

// Calendar-day gap between two YYYY-MM-DD keys, computed UTC-noon-to-UTC-noon
// so it's immune to the device tz the test is running under.
function dayGap(a: string, b: string): number {
  const toUtcNoon = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  return Math.round((toUtcNoon(b) - toUtcNoon(a)) / 86_400_000);
}
