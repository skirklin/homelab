/**
 * Characterization tests for the shared defensive JSON-column parsers in
 * `entries.ts` (`entriesFromRecord`, `labelsFromRecord`, `notesEntries`).
 *
 * These assert the CURRENT behavior, not an idealized one. Key facts pinned:
 *  - The parsers read `x.entries` / `x.labels` DIRECTLY (no `unwrapPbJson`),
 *    so they only handle ALREADY-PARSED shapes. A string-encoded JSON column
 *    or a goja byte-array is NOT array/object and degrades to []/undefined —
 *    these parsers assume PB's JS SDK has already parsed the column.
 *  - Per-item validation is strict and silent: any item that fails the
 *    type/shape gate is dropped, not coerced.
 */
import { describe, it, expect } from "vitest";
import type { RawRecord } from "../wrapped-pb/mirror";
import { entriesFromRecord, labelsFromRecord, notesEntries } from "./entries";

// The parsers only read .entries / .labels off a plain object, so a bare
// cast is the honest fake — no PocketBase stub needed.
const rec = (o: Record<string, unknown>): RawRecord => o as unknown as RawRecord;

describe("entriesFromRecord", () => {
  it("parses a well-formed mix of text/number/bool entries", () => {
    const out = entriesFromRecord(
      rec({
        entries: [
          { name: "notes", type: "text", value: "felt good" },
          { name: "amount", type: "number", value: 200, unit: "mg" },
          { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
          { name: "done", type: "bool", value: true },
        ],
      }),
    );
    expect(out).toEqual([
      { name: "notes", type: "text", value: "felt good" },
      { name: "amount", type: "number", value: 200, unit: "mg" },
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
      { name: "done", type: "bool", value: true },
    ]);
  });

  it("omits scale on number entries when absent (does not default it)", () => {
    const out = entriesFromRecord(
      rec({ entries: [{ name: "amount", type: "number", value: 1, unit: "ct" }] }),
    );
    expect(out).toEqual([{ name: "amount", type: "number", value: 1, unit: "ct" }]);
    expect("scale" in out[0]).toBe(false);
  });

  it("drops a non-numeric scale but keeps the number entry", () => {
    const out = entriesFromRecord(
      rec({ entries: [{ name: "r", type: "number", value: 3, unit: "rating", scale: "5" }] }),
    );
    expect(out).toEqual([{ name: "r", type: "number", value: 3, unit: "rating" }]);
  });

  it("returns [] for a missing entries field", () => {
    expect(entriesFromRecord(rec({}))).toEqual([]);
  });

  it("returns [] when entries is a JSON STRING (no unwrap — assumes pre-parsed)", () => {
    // This pins that the parser does NOT JSON.parse string columns.
    expect(entriesFromRecord(rec({ entries: '[{"name":"x","type":"text","value":"y"}]' }))).toEqual(
      [],
    );
  });

  it("returns [] when entries is null or a non-array object", () => {
    expect(entriesFromRecord(rec({ entries: null }))).toEqual([]);
    expect(entriesFromRecord(rec({ entries: { name: "x" } }))).toEqual([]);
  });

  it("drops malformed items but keeps the valid ones", () => {
    const out = entriesFromRecord(
      rec({
        entries: [
          null, // not an object
          "string", // not an object
          { type: "text", value: "no name" }, // missing name
          { name: 42, type: "text", value: "name not string" }, // name wrong type
          { name: "n", type: "number", value: 5 }, // number missing unit
          { name: "n2", type: "number", value: "5", unit: "mg" }, // value not number
          { name: "t", type: "text", value: 7 }, // text value not string
          { name: "b", type: "bool", value: "true" }, // bool value not boolean
          { name: "unknown", type: "weird", value: 1 }, // unknown type
          { name: "ok", type: "text", value: "kept" }, // valid -> kept
        ],
      }),
    );
    expect(out).toEqual([{ name: "ok", type: "text", value: "kept" }]);
  });

  it("returns [] for an empty entries array", () => {
    expect(entriesFromRecord(rec({ entries: [] }))).toEqual([]);
  });
});

describe("labelsFromRecord", () => {
  it("returns a flat string map when labels is a plain object", () => {
    expect(labelsFromRecord(rec({ labels: { mood: "good", place: "home" } }))).toEqual({
      mood: "good",
      place: "home",
    });
  });

  it("returns undefined when labels is missing", () => {
    expect(labelsFromRecord(rec({}))).toBeUndefined();
  });

  it("returns undefined when labels is null", () => {
    expect(labelsFromRecord(rec({ labels: null }))).toBeUndefined();
  });

  it("returns undefined when labels is an array (arrays are excluded)", () => {
    expect(labelsFromRecord(rec({ labels: ["a", "b"] }))).toBeUndefined();
  });

  it("returns undefined when labels is a string (no unwrap — assumes pre-parsed)", () => {
    expect(labelsFromRecord(rec({ labels: '{"mood":"good"}' }))).toBeUndefined();
  });

  it("passes an empty object through as-is (truthy object)", () => {
    expect(labelsFromRecord(rec({ labels: {} }))).toEqual({});
  });
});

describe("notesEntries", () => {
  it("wraps trimmed notes in a single text entry", () => {
    expect(notesEntries("  hello  ")).toEqual([
      { name: "notes", type: "text", value: "hello" },
    ]);
  });

  it("returns [] for undefined", () => {
    expect(notesEntries()).toEqual([]);
    expect(notesEntries(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(notesEntries("")).toEqual([]);
  });

  it("returns [] for a whitespace-only string", () => {
    expect(notesEntries("   \n\t ")).toEqual([]);
  });
});
