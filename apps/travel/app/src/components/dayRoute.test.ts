/**
 * Tests for the day-route helper, focused on the index-misalignment cases
 * that motivated the refactor. Before the fix, `DayView` consumed
 * `routeInfo.legs[j]` indexed by `day.slots[j]`, but the path that produced
 * `legs` was `[startLodging?, ...nonFlightSlotsWithCoords, endLodging?]` —
 * so any of these shifted the legs:
 *   1. A flight slot in `day.slots` (filtered out of the path).
 *   2. A lodging change (start/end lodging inserted at one or both ends).
 *   3. A slot whose activity has no coords (filtered out of the path).
 *
 * The helper makes that mapping explicit by returning a `legKeys` array
 * parallel to `legs`, and the consumer uses `buildDayLegMap` to ask "give me
 * the leg arriving at slot j" by slot index, not positional offset.
 */
import { describe, it, expect } from "vitest";
import { computeDayRoutePath, buildDayLegMap, type LegKey } from "./dayRoute";
import type { Activity, ItineraryDay, ItinerarySlot } from "../types";
import type { LegInfo } from "./ItineraryMap";

function mkAct(id: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `Activity ${id}`,
    category: "Sightseeing",
    location: "",
    placeId: "",
    lat: null,
    lng: null,
    description: "",
    costNotes: "",
    durationEstimate: "",
    walkMiles: null,
    elevationGainFeet: null,
    difficulty: "",
    confirmationCode: "",
    details: "",
    setting: "",
    bookingReqs: [],
    rating: null,
    ratingCount: null,
    photoRef: "",
    tripId: "trip1",
    created: new Date(),
    updated: new Date(),
    ...overrides,
  };
}

function mkSlot(activityId: string, overrides: Partial<ItinerarySlot> = {}): ItinerarySlot {
  return { activityId, ...overrides };
}

function mkDay(slots: ItinerarySlot[], overrides: Partial<ItineraryDay> = {}): ItineraryDay {
  return { label: "Day", slots, ...overrides };
}

function mkMap(acts: Activity[]): Map<string, Activity> {
  const m = new Map<string, Activity>();
  for (const a of acts) m.set(a.id, a);
  return m;
}

function mkLeg(durationMinutes: number, distanceMiles: number): LegInfo {
  return { durationMinutes, distanceMiles };
}

describe("computeDayRoutePath", () => {
  it("plain day: lodging A → slot 0 → slot 1 → lodging A (loop)", () => {
    const lodging = mkAct("L", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const a1 = mkAct("a1", { lat: 35.2, lng: -106.2 });
    const day = mkDay([mkSlot("a0"), mkSlot("a1")]);
    const am = mkMap([lodging, a0, a1]);

    const { path, legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodging,
      prevLodging: lodging,
    });

    expect(path).toEqual([
      { lat: 35.0, lng: -106.0 },
      { lat: 35.1, lng: -106.1 },
      { lat: 35.2, lng: -106.2 },
      { lat: 35.0, lng: -106.0 },
    ]);
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 0 },
      { kind: "slot", slotIndex: 1 },
      { kind: "end-lodging" },
    ]);
  });

  it("flight slot in the middle is excluded from the path; later slots keep correct slotIndex", () => {
    // day.slots = [hotel-coords-activity (or sightseeing), FLIGHT, sightseeing]
    // The old positional code would have taken legs[1] for slot index 1 (the
    // flight), but the path is [lodging, a0, a2, lodging] → legs are
    // [→a0, →a2, →lodging]. So `legs[1]` is actually the leg arriving at
    // slot index 2, not 1. The helper must label it as slotIndex=2.
    const lodging = mkAct("L", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const flight = mkAct("f0", { category: "Flight" });
    const a2 = mkAct("a2", { lat: 35.2, lng: -106.2 });
    const day = mkDay([mkSlot("a0"), mkSlot("f0"), mkSlot("a2")]);
    const am = mkMap([lodging, a0, flight, a2]);

    const { path, legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodging,
      prevLodging: lodging,
    });

    expect(path).toHaveLength(4); // lodging, a0, a2, lodging
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 0 },
      { kind: "slot", slotIndex: 2 }, // critical — NOT slotIndex 1
      { kind: "end-lodging" },
    ]);
  });

  it("lodging change at start: previous lodging is the path origin, this day's lodging is the destination", () => {
    const lodgingA = mkAct("LA", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const lodgingB = mkAct("LB", { category: "Accommodation", lat: 36.0, lng: -107.0 });
    const a0 = mkAct("a0", { lat: 35.5, lng: -106.5 });
    const day = mkDay([mkSlot("a0")]);
    const am = mkMap([lodgingA, lodgingB, a0]);

    const { path, legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodgingB,
      prevLodging: lodgingA,
    });

    expect(path).toEqual([
      { lat: 35.0, lng: -106.0 }, // start: yesterday's lodging
      { lat: 35.5, lng: -106.5 }, // stop slot 0
      { lat: 36.0, lng: -107.0 }, // end: tonight's lodging
    ]);
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 0 },
      { kind: "end-lodging" },
    ]);
  });

  it("slot with missing coordinates is dropped, and the next-slot leg still maps to the right slotIndex", () => {
    // The old code computed `nonFlightActivities.filter(coords != null)` and
    // then used `j` from `day.slots` for the leg lookup. A no-coords slot in
    // the middle would shift everything after it by one.
    const lodging = mkAct("L", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const a1NoCoords = mkAct("a1", { lat: null, lng: null });
    const a2 = mkAct("a2", { lat: 35.2, lng: -106.2 });
    const day = mkDay([mkSlot("a0"), mkSlot("a1"), mkSlot("a2")]);
    const am = mkMap([lodging, a0, a1NoCoords, a2]);

    const { path, legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodging,
      prevLodging: lodging,
    });

    expect(path).toHaveLength(4); // lodging, a0, a2, lodging
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 0 },
      { kind: "slot", slotIndex: 2 }, // not 1 — slot 1 has no coords
      { kind: "end-lodging" },
    ]);
  });

  it("no lodging at all (idea trip): path is just stops; first stop has no incoming leg", () => {
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const a1 = mkAct("a1", { lat: 35.2, lng: -106.2 });
    const day = mkDay([mkSlot("a0"), mkSlot("a1")]);
    const am = mkMap([a0, a1]);

    const { path, legKeys } = computeDayRoutePath(day, am, {});

    expect(path).toEqual([
      { lat: 35.1, lng: -106.1 },
      { lat: 35.2, lng: -106.2 },
    ]);
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 1 },
    ]);
  });

  it("a slot pointing at the lodging activity itself does not duplicate the bookend", () => {
    // Pattern: user adds the hotel as both `lodgingActivityId` and a slot
    // entry. The bookend already covers it; we'd otherwise emit a zero-length
    // leg from lodging→lodging.
    const lodging = mkAct("L", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const day = mkDay([mkSlot("L"), mkSlot("a0")]);
    const am = mkMap([lodging, a0]);

    const { path, legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodging,
      prevLodging: lodging,
    });

    expect(path).toHaveLength(3); // lodging, a0, lodging — NOT lodging, lodging, a0, lodging
    expect(legKeys).toEqual<LegKey[]>([
      { kind: "slot", slotIndex: 1 },
      { kind: "end-lodging" },
    ]);
  });
});

describe("buildDayLegMap", () => {
  it("maps legs to the slots they arrive at, via legKeys", () => {
    const legKeys: LegKey[] = [
      { kind: "slot", slotIndex: 0 },
      { kind: "slot", slotIndex: 2 },
      { kind: "end-lodging" },
    ];
    const legs: LegInfo[] = [mkLeg(15, 10), mkLeg(45, 30), mkLeg(20, 12)];

    const { legBySlotIndex, endLodgingLeg } = buildDayLegMap(legKeys, legs);

    expect(legBySlotIndex.get(0)).toEqual(mkLeg(15, 10));
    expect(legBySlotIndex.get(2)).toEqual(mkLeg(45, 30));
    expect(legBySlotIndex.has(1)).toBe(false); // slot 1 was a flight — no leg
    expect(endLodgingLeg).toEqual(mkLeg(20, 12));
  });

  it("handles a length mismatch defensively (maps what it can)", () => {
    const legKeys: LegKey[] = [
      { kind: "slot", slotIndex: 0 },
      { kind: "end-lodging" },
    ];
    const legs: LegInfo[] = [mkLeg(10, 5)]; // only one — Routes API hiccup

    const { legBySlotIndex, endLodgingLeg } = buildDayLegMap(legKeys, legs);
    expect(legBySlotIndex.get(0)).toEqual(mkLeg(10, 5));
    expect(endLodgingLeg).toBeUndefined();
  });

  it("end-to-end: flight-day legs land on the right slot indices", () => {
    // Reconstruct the misalignment case end-to-end. Path:
    //   lodging → a0 → a2 → lodging
    // Routes API returns 3 legs. With the old positional code, DayView would
    // have used legs[1] (the leg arriving at a2, ~45 min) under slot index 1
    // (the flight — should have shown nothing).
    const lodging = mkAct("L", { category: "Accommodation", lat: 35.0, lng: -106.0 });
    const a0 = mkAct("a0", { lat: 35.1, lng: -106.1 });
    const flight = mkAct("f0", { category: "Flight" });
    const a2 = mkAct("a2", { lat: 35.2, lng: -106.2 });
    const day = mkDay([mkSlot("a0"), mkSlot("f0"), mkSlot("a2")]);
    const am = mkMap([lodging, a0, flight, a2]);

    const { legKeys } = computeDayRoutePath(day, am, {
      todayLodging: lodging,
      prevLodging: lodging,
    });
    const legs: LegInfo[] = [mkLeg(15, 10), mkLeg(45, 30), mkLeg(20, 12)];
    const { legBySlotIndex, endLodgingLeg } = buildDayLegMap(legKeys, legs);

    expect(legBySlotIndex.get(0)).toEqual(mkLeg(15, 10));
    expect(legBySlotIndex.has(1)).toBe(false); // flight slot — correctly nothing
    expect(legBySlotIndex.get(2)).toEqual(mkLeg(45, 30));
    expect(endLodgingLeg).toEqual(mkLeg(20, 12));
  });
});
