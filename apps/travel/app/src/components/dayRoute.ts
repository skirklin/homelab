/**
 * Pure helpers for building a day's driving-route path and mapping the
 * resulting per-leg drive info back to the slot it arrives at.
 *
 * The crucial invariant: the path passed to the Routes API is NOT the same as
 * `day.slots` in order or length. Flights are excluded, slots with missing
 * coords are dropped, and start/end lodging coords are inserted as bookends.
 * So `legs[i]` from the Routes API response cannot be addressed by the
 * positional `day.slots` index — that mismatches the moment a day has a flight
 * slot, a lodging change, or a slot without coords.
 *
 * This module owns the source of truth: it returns both the coordinate path
 * (consumed by `ItineraryMap` to draw / query the API) and a parallel
 * `legKeys` array that identifies what each leg arrives at. Consumers
 * (`DayView`, `ItinerarySection`) build a slot-indexed map from `(legKeys,
 * legs)` instead of indexing positionally into `legs`.
 */
import type { Activity, ItineraryDay } from "../types";
import type { LegInfo } from "./ItineraryMap";

export interface Coord { lat: number; lng: number }

/**
 * Identifies what a leg arrives at. Either a specific slot (by 0-based index
 * into `day.slots`) or the end lodging. Start-lodging is implicit — it's the
 * origin and no leg "arrives" at it.
 */
export type LegKey =
  | { kind: "slot"; slotIndex: number }
  | { kind: "end-lodging" };

export interface DayRoutePath {
  /** Coordinate path passed to the Routes API. May be empty / single-point if not enough coords. */
  path: Coord[];
  /**
   * `legKeys[i]` identifies the destination of `path[i] -> path[i+1]`.
   * Length is `max(0, path.length - 1)`.
   */
  legKeys: LegKey[];
}

export interface DayRouteContext {
  /** This day's lodging (where you sleep tonight), if it has coords. */
  todayLodging?: Activity;
  /** Previous day's lodging (where you woke up), if it has coords. */
  prevLodging?: Activity;
}

function hasCoords(a: Activity | undefined): a is Activity & { lat: number; lng: number } {
  return !!a && a.lat != null && a.lng != null;
}

function coord(a: Activity): Coord {
  return { lat: a.lat as number, lng: a.lng as number };
}

function sameCoord(a: Coord | undefined, b: Coord | undefined): boolean {
  return !!a && !!b && a.lat === b.lat && a.lng === b.lng;
}

/**
 * Build the driving-route path for a single day and the parallel `legKeys`
 * array that maps each leg back to the slot (or end-lodging) it arrives at.
 *
 * Excluded from the path:
 *   - Flights (handled separately as map segments).
 *   - Slots whose activity has no coordinates.
 *   - The activity referenced by `todayLodging` / `prevLodging` when it would
 *     otherwise duplicate the lodging bookend.
 *
 * Start-lodging is prev-day's lodging (or today's, on day one). End-lodging is
 * today's lodging (or prev-day's, if today has none yet).
 */
export function computeDayRoutePath(
  day: ItineraryDay,
  activityMap: Map<string, Activity>,
  ctx: DayRouteContext,
): DayRoutePath {
  const startLodging = ctx.prevLodging ?? ctx.todayLodging;
  const endLodging = ctx.todayLodging ?? ctx.prevLodging;

  const startCoord: Coord | null = hasCoords(startLodging) ? coord(startLodging) : null;
  const endCoord: Coord | null = hasCoords(endLodging) ? coord(endLodging) : startCoord;

  // Resolve each slot in order. Track its slot index so we can map legs back.
  // Flights and missing-coords are dropped. Slots that point at the lodging
  // activity itself are dropped too (the lodging bookend already represents
  // arrival there — duplicating it would emit a zero-length leg).
  const lodgingIds = new Set<string>();
  if (ctx.todayLodging) lodgingIds.add(ctx.todayLodging.id);
  if (ctx.prevLodging) lodgingIds.add(ctx.prevLodging.id);

  type Stop = { slotIndex: number; coord: Coord };
  const stops: Stop[] = [];
  day.slots.forEach((slot, slotIndex) => {
    const act = activityMap.get(slot.activityId);
    if (!act) return;
    if (act.category === "Flight") return;
    if (!hasCoords(act)) return;
    if (lodgingIds.has(act.id)) return;
    stops.push({ slotIndex, coord: coord(act) });
  });

  // Assemble the path.
  const path: Coord[] = [];
  const legKeys: LegKey[] = [];

  if (startCoord) path.push(startCoord);
  for (const s of stops) {
    if (path.length === 0) {
      // No start lodging — first stop is the path origin, no leg yet.
      path.push(s.coord);
    } else {
      path.push(s.coord);
      legKeys.push({ kind: "slot", slotIndex: s.slotIndex });
    }
  }

  // End-lodging: append if it's distinct from the last point on the path, OR
  // if it forms the "loop" (same as start, no intermediate stops).
  if (endCoord) {
    const last = path[path.length - 1];
    if (!last) {
      // Path is empty and we have an end coord — push it; no leg.
      path.push(endCoord);
    } else if (!sameCoord(last, endCoord)) {
      path.push(endCoord);
      legKeys.push({ kind: "end-lodging" });
    } else if (stops.length === 0 && sameCoord(startCoord ?? undefined, endCoord)) {
      // Same lodging start+end, no stops — keep the original "complete the
      // loop" behavior so the polyline draws something visible at the
      // lodging. The leg is degenerate (length 0) but harmless; we still tag
      // it so consumers can distinguish it from a missing-data case.
      path.push(endCoord);
      legKeys.push({ kind: "end-lodging" });
    }
  }

  return { path, legKeys };
}

/**
 * Per-slot drive info for one day. Built by zipping `(legKeys, legs)` from
 * `computeDayRoutePath` + the Routes API response. Consumers ask "what's the
 * leg that arrives at this slot?" by slot index, not by positional offset
 * into `legs`.
 */
export interface DayLegMap {
  /** `legBySlotIndex.get(j)` is the drive arriving at `day.slots[j]`. */
  legBySlotIndex: Map<number, LegInfo>;
  /** Drive from the last slot (or start lodging) to the end-lodging. */
  endLodgingLeg?: LegInfo;
}

/**
 * Zip `legKeys` (from `computeDayRoutePath`) with the `legs` array returned
 * by the Routes API (or the haversine estimator) and produce a slot-indexed
 * map. Lengths should match; if they don't (defensive: API quirks), we map
 * what we can.
 */
export function buildDayLegMap(
  legKeys: LegKey[],
  legs: LegInfo[],
): DayLegMap {
  const legBySlotIndex = new Map<number, LegInfo>();
  let endLodgingLeg: LegInfo | undefined;
  const n = Math.min(legKeys.length, legs.length);
  for (let i = 0; i < n; i++) {
    const key = legKeys[i];
    const leg = legs[i];
    if (key.kind === "slot") {
      legBySlotIndex.set(key.slotIndex, leg);
    } else {
      endLodgingLeg = leg;
    }
  }
  return { legBySlotIndex, endLodgingLeg };
}
