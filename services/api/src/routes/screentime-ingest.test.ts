/**
 * Focused unit tests for the pure pieces of the screen-time mapper: the
 * normalized per-app field and the compare/replace decision (changed vs
 * unchanged) that drives upsert-replace. No PB / network.
 */
import { describe, it, expect } from "vitest";
import { __test } from "./screentime-ingest";

const { appsField, buildEntries, readExisting } = __test;

describe("appsField", () => {
  it("keeps only {package,name,minutes}, dropping last_used and order-preserving", () => {
    const apps = [
      { package: "com.b", name: "B", minutes: 30, last_used: "2026-06-14T10:00:00Z" },
      { package: "com.a", name: "A", minutes: 10, last_used: "2026-06-14T09:00:00Z" },
    ];
    expect(appsField(apps)).toEqual([
      { package: "com.b", name: "B", minutes: 30 },
      { package: "com.a", name: "A", minutes: 10 },
    ]);
  });

  it("returns [] for a missing/non-array apps field", () => {
    expect(appsField(undefined)).toEqual([]);
    expect(appsField(null)).toEqual([]);
    expect(appsField("nope")).toEqual([]);
  });

  it("coerces missing/garbage fields to safe defaults", () => {
    expect(appsField([{ minutes: 5 }])).toEqual([{ package: "", name: "", minutes: 5 }]);
    expect(appsField([{ package: "x", name: "X", minutes: NaN }])).toEqual([
      { package: "x", name: "X", minutes: 0 },
    ]);
  });
});

describe("readExisting + upsert-replace decision", () => {
  const appsJson = JSON.stringify([{ package: "com.a", name: "A", minutes: 10 }]);

  it("round-trips total + appsJson out of stored entries", () => {
    const entries = buildEntries(120, appsJson);
    const prev = readExisting(entries);
    expect(prev.total).toBe(120);
    expect(prev.appsJson).toBe(appsJson);
  });

  it("treats an identical restatement as unchanged", () => {
    const entries = buildEntries(120, appsJson);
    const prev = readExisting(entries);
    const unchanged = prev.total === 120 && prev.appsJson === appsJson;
    expect(unchanged).toBe(true);
  });

  it("detects a changed total (today's figure grew)", () => {
    const entries = buildEntries(120, appsJson);
    const prev = readExisting(entries);
    const changed = prev.total !== 145 || prev.appsJson !== appsJson;
    expect(changed).toBe(true);
  });

  it("detects a changed apps breakdown with the same total", () => {
    const entries = buildEntries(120, appsJson);
    const prev = readExisting(entries);
    const newApps = JSON.stringify([{ package: "com.b", name: "B", minutes: 120 }]);
    const changed = prev.total !== 120 || prev.appsJson !== newApps;
    expect(changed).toBe(true);
  });

  it("defaults total=null and appsJson='[]' for malformed/empty entries", () => {
    expect(readExisting(undefined)).toEqual({ total: null, appsJson: "[]" });
    expect(readExisting([])).toEqual({ total: null, appsJson: "[]" });
  });
});
