/**
 * Pure-logic tests for the notes-thread selectors/encoders. These back the
 * <NotesThread> component but run without a DOM — fast coverage of the entry
 * encode/decode + the log-scoped subject filter + the optimistic-sort fallback.
 */
import { describe, it, expect } from "vitest";
import type { TravelNote, LifeEntry } from "../types";
import {
  selectNotes,
  isImported,
  verdictOf,
  activityNotesText,
  activityEntries,
  dayFieldsOf,
  dayEntries,
  daySubjectId,
  tripEntries,
  tripNotesText,
  isEmptyEntries,
} from "./noteEntries";

function note(
  id: string,
  createdBy: string,
  subjectType: string,
  subjectId: string,
  entries: LifeEntry[],
  created = "2026-06-01T00:00:00Z",
): TravelNote {
  return { id, log: "log1", subjectType, subjectId, createdBy, entries, created, updated: created };
}

describe("selectNotes", () => {
  it("filters by (subjectType, subjectId) in memory — log-scoped, never cross-log", () => {
    const all = [
      note("a", "u1", "activity", "act1", []),
      note("b", "u2", "activity", "act2", []),
      note("c", "u1", "day", "act1", []), // same id, different type
    ];
    const got = selectNotes(all, "activity", "act1");
    expect(got.map((n) => n.id)).toEqual(["a"]);
  });

  it("sorts newest-first", () => {
    const all = [
      note("old", "u1", "trip", "t1", [], "2026-06-01T00:00:00Z"),
      note("new", "u2", "trip", "t1", [], "2026-06-03T00:00:00Z"),
      note("mid", "u3", "trip", "t1", [], "2026-06-02T00:00:00Z"),
    ];
    expect(selectNotes(all, "trip", "t1").map((n) => n.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts an optimistic note (empty created) to the top via the now-fallback", () => {
    const all = [
      note("server", "u1", "trip", "t1", [], "2026-06-03T00:00:00Z"),
      note("optimistic", "u2", "trip", "t1", [], ""),
    ];
    expect(selectNotes(all, "trip", "t1")[0].id).toBe("optimistic");
  });
});

describe("isImported", () => {
  it("treats createdBy==='' as imported, anyone else as attributed", () => {
    expect(isImported(note("x", "", "trip", "t1", []))).toBe(true);
    expect(isImported(note("a", "scott", "trip", "t1", []))).toBe(false);
  });
});

describe("activity entries", () => {
  it("decodes the caller's verdict + notes", () => {
    const n = note("a", "scott", "activity", "act1", [
      { name: "verdict", type: "text", value: "loved" },
      { name: "notes", type: "text", value: "great" },
    ]);
    expect(verdictOf(n)).toBe("loved");
    expect(activityNotesText(n)).toBe("great");
  });

  it("ignores a non-verdict text value in the verdict slot", () => {
    const n = note("a", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "garbage" }]);
    expect(verdictOf(n)).toBeUndefined();
  });

  it("encodes only non-empty values, dropping a cleared verdict", () => {
    expect(activityEntries("loved", "  hi ")).toEqual([
      { name: "verdict", type: "text", value: "loved" },
      { name: "notes", type: "text", value: "hi" },
    ]);
    expect(activityEntries(null, "")).toEqual([]);
    expect(isEmptyEntries(activityEntries(null, "   "))).toBe(true);
  });
});

describe("day entries", () => {
  it("round-trips text/highlight/mood", () => {
    const entries = dayEntries({ text: "walked far", highlight: "the sunset", mood: 4 });
    expect(entries).toContainEqual({ name: "text", type: "text", value: "walked far" });
    expect(entries).toContainEqual({ name: "highlight", type: "text", value: "the sunset" });
    expect(entries).toContainEqual({ name: "mood", type: "number", value: 4, unit: "rating", scale: 5 });

    const n = note("d", "scott", "day", daySubjectId("trip1", "2026-06-01"), entries);
    expect(dayFieldsOf(n)).toEqual({ text: "walked far", highlight: "the sunset", mood: 4 });
  });

  it("omits empty fields", () => {
    expect(dayEntries({ text: "", highlight: "", mood: null })).toEqual([]);
    expect(dayEntries({ text: "x", highlight: "", mood: null })).toEqual([
      { name: "text", type: "text", value: "x" },
    ]);
  });

  it("builds the composite subjectId, split-on-first-colon safe", () => {
    expect(daySubjectId("trip1", "2026-06-01")).toBe("trip1:2026-06-01");
  });
});

describe("trip entries", () => {
  it("round-trips trip notes and drops empties", () => {
    expect(tripEntries("hello")).toEqual([{ name: "notes", type: "text", value: "hello" }]);
    expect(tripEntries("   ")).toEqual([]);
    const n = note("t", "scott", "trip", "t1", tripEntries("hello"));
    expect(tripNotesText(n)).toBe("hello");
  });
});
