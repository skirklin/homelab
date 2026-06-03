/**
 * Phase 4 — the per-user notes thread. Each author gets their own stacked,
 * cross-visible note; only the current user may edit/delete their own; an
 * imported (createdBy==="") row is read-only and unattributed; and
 * VerdictButtons reflects the CALLER'S verdict, not someone else's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TravelNote, LifeEntry } from "../types";

// --- backend + shared mocks ------------------------------------------------
const addNote = vi.fn().mockResolvedValue("note-new");
const updateNote = vi.fn().mockResolvedValue(undefined);
const deleteNote = vi.fn().mockResolvedValue(undefined);

// The notes the component should read from the log-scoped mirror state.
let stateNotes: TravelNote[] = [];

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({ message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }),
    useAuth: () => ({ user: { uid: "scott", name: "Scott" } }),
    useTravelBackend: () => ({ addNote, updateNote, deleteNote }),
    // Resolve the other author's id; "" must never be looked up.
    useUserNames: (ids: Array<string | undefined>) => {
      const m = new Map<string, string>();
      m.set("scott", "Scott");
      if (ids.includes("angela")) m.set("angela", "Angela");
      return m;
    },
  };
});

vi.mock("../travel-context", () => ({
  useTravelContext: () => ({ state: { notes: stateNotes, log: { id: "log1" } } }),
}));

import { NotesThread } from "./NotesThread";

beforeEach(() => {
  addNote.mockClear();
  updateNote.mockClear();
  deleteNote.mockClear();
  stateNotes = [];
});

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

describe("NotesThread — activity reflection", () => {
  it("renders one note per author with their name, both cross-visible", () => {
    stateNotes = [
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "loved the view" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "too crowded" }], "2026-06-02T00:00:00Z"),
    ];
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.getByText("Scott")).toBeTruthy();
    expect(screen.getByText("Angela")).toBeTruthy();
    expect(screen.getByText(/loved the view/)).toBeTruthy();
    expect(screen.getByText(/too crowded/)).toBeTruthy();
  });

  it("shows edit/delete affordances ONLY on the current user's own note", () => {
    stateNotes = [
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "theirs" }]),
    ];
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    const scottRow = screen.getByTestId("note-n1");
    const angelaRow = screen.getByTestId("note-n2");
    expect(within(scottRow).queryByTestId("note-edit")).not.toBeNull();
    expect(within(scottRow).queryByTestId("note-delete")).not.toBeNull();
    expect(within(angelaRow).queryByTestId("note-edit")).toBeNull();
    expect(within(angelaRow).queryByTestId("note-delete")).toBeNull();
  });

  it("renders createdBy==='' as Imported, unattributed and non-editable", () => {
    stateNotes = [
      note("n0", "", "activity", "act1", [{ name: "notes", type: "text", value: "legacy note" }]),
    ];
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    const row = screen.getByTestId("note-n0");
    expect(within(row).getByText(/Imported/i)).toBeTruthy();
    expect(within(row).queryByTestId("note-edit")).toBeNull();
    expect(within(row).queryByTestId("note-delete")).toBeNull();
    expect(screen.getByText(/legacy note/)).toBeTruthy();
  });

  it("offers an add-my-note affordance only when the caller has no note yet", () => {
    // Caller (scott) already has a note → no add affordance.
    stateNotes = [note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }])];
    const { rerender } = render(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.queryByTestId("note-add")).toBeNull();

    // Only someone else's note → caller may add their own.
    stateNotes = [note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "theirs" }])];
    rerender(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.queryByTestId("note-add")).not.toBeNull();
  });
});

describe("NotesThread — verdict is per-caller", () => {
  it("VerdictButtons reflects the caller's own verdict, not someone else's", () => {
    stateNotes = [
      // Scott (caller) loved it; Angela skipped it.
      note("n1", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
      note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }]),
    ];
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const loved = screen.getByTestId("verdict-loved");
    const skip = screen.getByTestId("verdict-skip");
    // The caller's active verdict is "loved"; "skip" (Angela's) must NOT be active.
    expect(loved.getAttribute("data-active")).toBe("true");
    expect(skip.getAttribute("data-active")).toBe("false");
  });

  it("clicking a verdict upserts into the caller's own note", async () => {
    const user = userEvent.setup();
    // Caller has no note yet.
    stateNotes = [note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }])];
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await user.click(screen.getByTestId("verdict-loved"));
    expect(addNote).toHaveBeenCalledTimes(1);
    const [logId, subjectType, subjectId, userId, entries] = addNote.mock.calls[0];
    expect(logId).toBe("log1");
    expect(subjectType).toBe("activity");
    expect(subjectId).toBe("act1");
    expect(userId).toBe("scott");
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "loved" });
  });
});

describe("NotesThread — day subject", () => {
  it("filters notes by the composite day subjectId", () => {
    stateNotes = [
      note("d1", "scott", "day", "trip1:2026-06-01", [{ name: "text", type: "text", value: "great day" }]),
      note("d2", "angela", "day", "trip1:2026-06-02", [{ name: "text", type: "text", value: "other day" }]),
    ];
    render(<NotesThread subjectType="day" subjectId="trip1:2026-06-01" />);
    expect(screen.getByText(/great day/)).toBeTruthy();
    expect(screen.queryByText(/other day/)).toBeNull();
  });
});
