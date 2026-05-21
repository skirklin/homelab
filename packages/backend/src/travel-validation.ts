/**
 * Canonical implementation of `validateDay` and its helpers.
 *
 * The travel UI surfaces day-level planning issues (overlap, out-of-order,
 * drive-gap) as the "N issues" badge per itinerary day; the MCP server returns
 * the same per-day verdicts. Both consumers import from here so the algorithm
 * doesn't drift.
 *
 * Tests live in `packages/backend/src/travel-validation.test.ts`. If you
 * change the algorithm, update those tests in lockstep.
 *
 * Field conventions: this module is **camelCase end-to-end** (`durationEstimate`,
 * `activityId`, `startTime`, `slotIndices`). Consumers reading snake_case API
 * responses (e.g. the MCP server reading `/travel/activities` which returns
 * `duration_estimate`) must normalize at their boundary before calling — that
 * keeps the validator's contract clean.
 */

export type DayIssueKind = "overlap" | "out-of-order" | "drive-gap";

export interface DayIssue {
  kind: DayIssueKind;
  message: string;
  /** Slot indices involved, in the order they appear in the day's slots array. */
  slotIndices: [number, number];
}

/**
 * Activity shape the validator needs. Loose enough to be satisfied by both
 * the travel UI's local `Activity` type (`lat: number | null`) and the backend
 * `Activity` type (`lat?: number`) without a conversion step at the callsite.
 */
export interface ValidationActivity {
  id: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  durationEstimate?: string;
}

/** Itinerary slot shape as stored in PB's `days[].slots[]` JSON. */
export interface ValidationSlot {
  activityId: string;
  startTime?: string;
}

/**
 * Parse a time-of-day string into minutes from midnight. Accepts 24-hour
 * "HH:mm" and 12-hour "h:mm AM/PM" (and minor variants); returns null if
 * the string is unparseable. Production itineraries use the 12-hour form,
 * but the input is user-editable so we stay permissive.
 */
export function parseTimeOfDay(time: string | undefined): number | null {
  if (!time) return null;
  const t = time.trim();

  // 12-hour with meridiem: "8:00 AM", "1:00 PM", "12:30pm", "8 AM"
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const pm = ampm[3].toUpperCase() === "PM";
    if (h < 1 || h > 12 || m > 59) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
    return h * 60 + m;
  }

  // 24-hour: "09:00", "13:45"
  const hhmm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  return null;
}

/** Parse a duration string like "2-3 hours", "45m", "half day", "evening" into hours. */
export function parseDurationHours(dur: string | null | undefined): number {
  if (!dur) return 0;
  const d = dur.toLowerCase().trim();
  if (d === "full day") return 6;
  if (d === "half day") return 3;
  if (d === "evening") return 3;
  // "2-3 hours" -> average
  const rangeHr = d.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*h/);
  if (rangeHr) return (parseFloat(rangeHr[1]) + parseFloat(rangeHr[2])) / 2;
  // "2h", "2 hours", "2.5h"
  const singleHr = d.match(/^(\d+(?:\.\d+)?)\s*h/);
  if (singleHr) return parseFloat(singleHr[1]);
  // "45m", "45 min", "30 min"
  const mins = d.match(/^(\d+)\s*m/);
  if (mins) return parseInt(mins[1]) / 60;
  // "4.5 hours"
  const hoursWord = d.match(/(\d+(?:\.\d+)?)\s*hours?/);
  if (hoursWord) return parseFloat(hoursWord[1]);
  return 0;
}

/** Format minutes-from-midnight as "HH:mm" (values past 24h render as e.g. "25:30"). */
function formatMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Haversine distance in miles between two lat/lng points. */
function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3959; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sin2Lat = Math.sin(dLat / 2) ** 2;
  const sin2Lng = Math.sin(dLng / 2) ** 2;
  const h = sin2Lat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sin2Lng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Estimate driving time in hours from haversine distance (rough: 30mph average with stops). */
function estimateDriveHours(miles: number): number {
  if (miles <= 0) return 0;
  return miles / 30;
}

/**
 * Check a day's scheduled slots for issues:
 *   - overlap: two activities whose [start, start+duration] ranges intersect
 *   - out-of-order: slots listed in a different order than their start times
 *   - drive-gap: consecutive scheduled activities in different places where
 *     the haversine-estimated drive is longer than the scheduled gap
 *
 * Activities without a startTime, or that can't be resolved in activityMap,
 * are skipped. If `durationEstimate` is unparseable (yields 0 hours), the
 * activity contributes a zero-length point in time — overlap and drive-gap
 * checks skip it, but it still participates in out-of-order.
 */
export function validateDay(
  slots: ValidationSlot[],
  activityMap: Map<string, ValidationActivity>,
): DayIssue[] {
  interface Scheduled {
    index: number;
    startMin: number;
    endMin: number;
    activity: ValidationActivity;
  }
  const scheduled: Scheduled[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const startMin = parseTimeOfDay(slot.startTime);
    if (startMin == null) continue;
    const activity = activityMap.get(slot.activityId);
    if (!activity) continue;
    const durHours = parseDurationHours(activity.durationEstimate);
    scheduled.push({ index: i, startMin, endMin: startMin + durHours * 60, activity });
  }

  const issues: DayIssue[] = [];

  // Out of order: list position disagrees with start-time order.
  for (let i = 1; i < scheduled.length; i++) {
    const prev = scheduled[i - 1];
    const curr = scheduled[i];
    if (curr.startMin < prev.startMin) {
      issues.push({
        kind: "out-of-order",
        message: `${curr.activity.name} (${formatMin(curr.startMin)}) is listed after ${prev.activity.name} (${formatMin(prev.startMin)})`,
        slotIndices: [prev.index, curr.index],
      });
    }
  }

  // Overlap: any two scheduled activities with overlapping ranges. Requires
  // both to have positive duration — without it we can't define an end.
  for (let i = 0; i < scheduled.length; i++) {
    for (let j = i + 1; j < scheduled.length; j++) {
      const a = scheduled[i];
      const b = scheduled[j];
      if (a.endMin <= a.startMin || b.endMin <= b.startMin) continue;
      if (a.startMin < b.endMin && b.startMin < a.endMin) {
        issues.push({
          kind: "overlap",
          message: `${a.activity.name} (${formatMin(a.startMin)}–${formatMin(a.endMin)}) overlaps ${b.activity.name} (${formatMin(b.startMin)}–${formatMin(b.endMin)})`,
          slotIndices: [a.index, b.index],
        });
      }
    }
  }

  // Drive gap: consecutive activities (by time) in different places where
  // estimated travel exceeds the scheduled gap.
  const byTime = [...scheduled].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < byTime.length; i++) {
    const a = byTime[i - 1];
    const b = byTime[i];
    if (a.activity.lat == null || a.activity.lng == null) continue;
    if (b.activity.lat == null || b.activity.lng == null) continue;
    if (a.endMin <= a.startMin) continue;
    const miles = haversineMiles(
      { lat: a.activity.lat, lng: a.activity.lng },
      { lat: b.activity.lat, lng: b.activity.lng },
    );
    const driveMin = estimateDriveHours(miles) * 60;
    if (driveMin < 5) continue;
    const gapMin = b.startMin - a.endMin;
    if (gapMin < driveMin) {
      issues.push({
        kind: "drive-gap",
        message: `${Math.round(driveMin)}min drive from ${a.activity.name} to ${b.activity.name}, but only ${Math.round(gapMin)}min scheduled`,
        slotIndices: [a.index, b.index],
      });
    }
  }

  return issues;
}
