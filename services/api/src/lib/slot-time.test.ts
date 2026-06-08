import { describe, it, expect } from "vitest";
import { parseSlotTime, canonicalSlotTime } from "./slot-time";

describe("slot-time (API normalizer)", () => {
  it("parses both 24-hour and 12-hour forms", () => {
    expect(parseSlotTime("17:30")).toBe(17 * 60 + 30);
    expect(parseSlotTime("5:30 PM")).toBe(17 * 60 + 30);
    expect(parseSlotTime("5pm")).toBe(17 * 60);
    expect(parseSlotTime("12:00 AM")).toBe(0);
    expect(parseSlotTime("12pm")).toBe(12 * 60);
  });

  it("returns null for empty/garbage", () => {
    expect(parseSlotTime("")).toBeNull();
    expect(parseSlotTime(undefined)).toBeNull();
    expect(parseSlotTime("noon")).toBeNull();
    expect(parseSlotTime("25:00")).toBeNull();
  });

  it("canonicalizes to HH:MM and is idempotent", () => {
    expect(canonicalSlotTime("5:30 PM")).toBe("17:30");
    expect(canonicalSlotTime("9 am")).toBe("09:00");
    expect(canonicalSlotTime("17:30")).toBe("17:30");
    expect(canonicalSlotTime("garbage")).toBeUndefined();
  });
});
