import { describe, it, expect } from "vitest";
import { parseSlotTime, canonicalSlotTime, formatSlotTime } from "./time";

describe("parseSlotTime", () => {
  it("parses 24-hour HH:MM", () => {
    expect(parseSlotTime("17:30")).toBe(17 * 60 + 30);
    expect(parseSlotTime("09:00")).toBe(9 * 60);
    expect(parseSlotTime("9:00")).toBe(9 * 60);
    expect(parseSlotTime("00:00")).toBe(0);
    expect(parseSlotTime("23:59")).toBe(23 * 60 + 59);
  });

  it("parses 12-hour with meridiem in many shapes", () => {
    expect(parseSlotTime("5:30 PM")).toBe(17 * 60 + 30);
    expect(parseSlotTime("5 PM")).toBe(17 * 60);
    expect(parseSlotTime("5pm")).toBe(17 * 60);
    expect(parseSlotTime("5:30pm")).toBe(17 * 60 + 30);
    expect(parseSlotTime("5:30 p.m.")).toBe(17 * 60 + 30);
    expect(parseSlotTime("9:15 am")).toBe(9 * 60 + 15);
  });

  it("handles midnight/noon edges", () => {
    expect(parseSlotTime("12:00 AM")).toBe(0); // midnight
    expect(parseSlotTime("12am")).toBe(0);
    expect(parseSlotTime("12:00 PM")).toBe(12 * 60); // noon
    expect(parseSlotTime("12pm")).toBe(12 * 60);
    expect(parseSlotTime("12:30 AM")).toBe(30);
    expect(parseSlotTime("12:30 PM")).toBe(12 * 60 + 30);
  });

  it("returns null for empty/garbage", () => {
    expect(parseSlotTime("")).toBeNull();
    expect(parseSlotTime(undefined)).toBeNull();
    expect(parseSlotTime(null)).toBeNull();
    expect(parseSlotTime("noon")).toBeNull();
    expect(parseSlotTime("25:00")).toBeNull();
    expect(parseSlotTime("13 PM")).toBeNull(); // 13 isn't a valid 12-hour hour
    expect(parseSlotTime("9:99")).toBeNull();
    expect(parseSlotTime("abc")).toBeNull();
  });
});

describe("canonicalSlotTime", () => {
  it("normalizes accepted inputs to HH:MM", () => {
    expect(canonicalSlotTime("5:30 PM")).toBe("17:30");
    expect(canonicalSlotTime("5pm")).toBe("17:00");
    expect(canonicalSlotTime("9:00 AM")).toBe("09:00");
    expect(canonicalSlotTime("12:00 AM")).toBe("00:00");
    expect(canonicalSlotTime("12pm")).toBe("12:00");
  });

  it("is idempotent on already-canonical values", () => {
    for (const s of ["00:00", "09:00", "17:30", "23:59"]) {
      expect(canonicalSlotTime(s)).toBe(s);
      expect(canonicalSlotTime(canonicalSlotTime(s))).toBe(s);
    }
  });

  it("returns undefined for empty/unparseable", () => {
    expect(canonicalSlotTime("")).toBeUndefined();
    expect(canonicalSlotTime(undefined)).toBeUndefined();
    expect(canonicalSlotTime("garbage")).toBeUndefined();
  });
});

describe("formatSlotTime", () => {
  it("renders canonical 24-hour as human 12-hour", () => {
    expect(formatSlotTime("17:30")).toBe("5:30 PM");
    expect(formatSlotTime("09:00")).toBe("9:00 AM");
    expect(formatSlotTime("00:00")).toBe("12:00 AM");
    expect(formatSlotTime("12:00")).toBe("12:00 PM");
    expect(formatSlotTime("23:59")).toBe("11:59 PM");
  });

  it("renders legacy human strings consistently", () => {
    expect(formatSlotTime("5:30 PM")).toBe("5:30 PM");
    expect(formatSlotTime("5pm")).toBe("5:00 PM");
  });

  it("returns empty string for empty/unparseable", () => {
    expect(formatSlotTime("")).toBe("");
    expect(formatSlotTime(undefined)).toBe("");
    expect(formatSlotTime("garbage")).toBe("");
  });
});
