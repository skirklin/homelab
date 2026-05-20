import { describe, it, expect } from "vitest";
import { resolveSelectedItinerary } from "./useSelectedItinerary";
import type { Itinerary } from "../types";

function mkItin(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    id: "i1",
    tripId: "t1",
    name: "Option A",
    isActive: false,
    days: [],
    created: new Date(0),
    updated: new Date(0),
    ...overrides,
  };
}

describe("resolveSelectedItinerary", () => {
  it("returns undefined when itineraries list is empty", () => {
    expect(resolveSelectedItinerary([], null)).toBeUndefined();
    expect(resolveSelectedItinerary([], "anything")).toBeUndefined();
  });

  it("returns the itinerary matching the selected id when present", () => {
    const a = mkItin({ id: "a" });
    const b = mkItin({ id: "b", isActive: true });
    expect(resolveSelectedItinerary([a, b], "a")).toBe(a);
  });

  it("falls back to the active itinerary when no id is selected", () => {
    const a = mkItin({ id: "a" });
    const b = mkItin({ id: "b", isActive: true });
    expect(resolveSelectedItinerary([a, b], null)).toBe(b);
  });

  it("falls back to the active itinerary when the selected id is unknown", () => {
    const a = mkItin({ id: "a" });
    const b = mkItin({ id: "b", isActive: true });
    expect(resolveSelectedItinerary([a, b], "missing")).toBe(b);
  });

  it("falls back to the first itinerary when none is active", () => {
    const a = mkItin({ id: "a" });
    const b = mkItin({ id: "b" });
    expect(resolveSelectedItinerary([a, b], null)).toBe(a);
  });

  it("treats empty-string selected id as no selection", () => {
    const a = mkItin({ id: "a" });
    const b = mkItin({ id: "b", isActive: true });
    expect(resolveSelectedItinerary([a, b], "")).toBe(b);
  });
});
