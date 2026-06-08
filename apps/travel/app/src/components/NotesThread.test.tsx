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

// The notes the component should read from the log-scoped mirror state. Real
// state is a Map<string, TravelNote> (see travel-context reducer); the mock
// mirrors that so call-time re-selection (notes.values()) behaves like prod.
let stateNotes = new Map<string, TravelNote>();

/** Replace the mock state's notes from a flat list (test ergonomics). */
function setStateNotes(list: TravelNote[]) {
  stateNotes = new Map(list.map((n) => [n.id, n]));
}

/**
 * Mutate the SAME Map in place — no new reference. This reproduces the stale-
 * render window: the component's `useMemo([state.notes])` keeps `mine` frozen
 * (the Map ref is unchanged) while a live re-read of `state.notes.values()`
 * sees the freshly-landed note. A correct write handler must consult the live
 * read at call time, not the frozen `mine`.
 */
function injectNoteInPlace(n: TravelNote) {
  stateNotes.set(n.id, n);
}

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
  setStateNotes([]);
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
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "loved the view" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "too crowded" }], "2026-06-02T00:00:00Z"),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.getByText("Scott")).toBeTruthy();
    expect(screen.getByText("Angela")).toBeTruthy();
    expect(screen.getByText(/loved the view/)).toBeTruthy();
    expect(screen.getByText(/too crowded/)).toBeTruthy();
  });

  it("shows edit/delete affordances ONLY on the current user's own note", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "theirs" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    const scottRow = screen.getByTestId("note-n1");
    const angelaRow = screen.getByTestId("note-n2");
    expect(within(scottRow).queryByTestId("note-edit")).not.toBeNull();
    expect(within(scottRow).queryByTestId("note-delete")).not.toBeNull();
    expect(within(angelaRow).queryByTestId("note-edit")).toBeNull();
    expect(within(angelaRow).queryByTestId("note-delete")).toBeNull();
  });

  it("renders createdBy==='' as Imported, unattributed and non-editable", () => {
    setStateNotes([
      note("n0", "", "activity", "act1", [{ name: "notes", type: "text", value: "legacy note" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    const row = screen.getByTestId("note-n0");
    expect(within(row).getByText(/Imported/i)).toBeTruthy();
    expect(within(row).queryByTestId("note-edit")).toBeNull();
    expect(within(row).queryByTestId("note-delete")).toBeNull();
    expect(screen.getByText(/legacy note/)).toBeTruthy();
  });

  it("offers an add-my-note affordance only when the caller has no note yet", () => {
    // Caller (scott) already has a note → no add affordance.
    setStateNotes([note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }])]);
    const { rerender } = render(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.queryByTestId("note-add")).toBeNull();

    // Only someone else's note → caller may add their own.
    setStateNotes([note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "theirs" }])]);
    rerender(<NotesThread subjectType="activity" subjectId="act1" />);
    expect(screen.queryByTestId("note-add")).not.toBeNull();
  });
});

describe("NotesThread — verdict is per-caller", () => {
  it("VerdictButtons reflects the caller's own verdict, not someone else's", () => {
    setStateNotes([
      // Scott (caller) loved it; Angela skipped it.
      note("n1", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
      note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }]),
    ]);
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
    setStateNotes([note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }])]);
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

describe("NotesThread — verdict lives in the caller's own reaction card", () => {
  it("renders an editable 'your reaction' card with the picker even when the caller has no note", () => {
    // Only someone else's note exists; the caller has none yet.
    setStateNotes([note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }])]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const reaction = screen.getByTestId("my-reaction");
    // The editable picker is inside the caller's own reaction card.
    expect(within(reaction).getByTestId("verdict-loved")).toBeTruthy();
  });

  it("one verdict tap with no prior note creates exactly ONE note with that verdict and no text", async () => {
    const user = userEvent.setup();
    setStateNotes([]); // caller has no note at all
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await user.click(screen.getByTestId("verdict-liked"));
    // Exactly one create, no modal/editor opened, no second row.
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(updateNote).not.toHaveBeenCalled();
    const entries = addNote.mock.calls[0][4] as LifeEntry[];
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "liked" });
    // No text entry — a bare rating.
    expect(entries.some((e) => e.name === "notes")).toBe(false);
  });

  it("with an existing note, the editable picker is in the caller's own card and tapping UPDATES, preserving text", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [
        { name: "verdict", type: "text", value: "liked" },
        { name: "notes", type: "text", value: "keep my words" },
      ]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    // The picker sits inside the caller's own note card.
    const ownCard = screen.getByTestId("note-n1");
    await user.click(within(ownCard).getByTestId("verdict-loved"));
    // Updates the existing row, never adds.
    expect(addNote).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote.mock.calls[0][0]).toBe("n1");
    const entries = updateNote.mock.calls[0][1] as LifeEntry[];
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "loved" });
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "keep my words" });
  });

  it("does not render a separate top-level reaction card once the caller has a note", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    // The standalone "your reaction" placeholder card is gone — the picker rides
    // in the caller's own note card instead.
    expect(screen.queryByTestId("my-reaction")).toBeNull();
    // Exactly one editable verdict picker exists (the caller's), not two.
    expect(screen.getAllByTestId("verdict-loved")).toHaveLength(1);
  });

  it("another author's verdict is shown read-only — no clickable picker in their card", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
      note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const angelaCard = screen.getByTestId("note-n2");
    // Their rating is visible…
    expect(within(angelaCard).getByText(/would skip/i)).toBeTruthy();
    // …but there is no editable verdict control in their card.
    expect(within(angelaCard).queryByTestId("verdict-skip")).toBeNull();
    expect(within(angelaCard).queryByTestId("verdict-loved")).toBeNull();
  });

  it("an imported note's verdict is read-only, not an editable picker", () => {
    setStateNotes([
      note("n0", "", "activity", "act1", [{ name: "verdict", type: "text", value: "meh" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const importedCard = screen.getByTestId("note-n0");
    expect(within(importedCard).getByText(/meh/i)).toBeTruthy();
    expect(within(importedCard).queryByTestId("verdict-meh")).toBeNull();
  });
});

describe("NotesThread — no duplicate note on stale-render save", () => {
  it("verdict tap re-checks live state and updates the note that landed since render", async () => {
    const user = userEvent.setup();
    // Render with no note → this render's `mine` is undefined.
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);

    // Scott's note lands via the mirror, mutating the SAME Map in place — so the
    // memoized `mine` stays frozen at undefined while live state now has a note.
    injectNoteInPlace(
      note("server-2", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "keep me" }]),
    );

    await user.click(screen.getByTestId("verdict-loved"));

    // Broken code would addNote a SECOND row off the stale undefined; the fix
    // re-selects live state at click time and UPDATES the landed note, keeping
    // its text. Exactly one row for (scott, act1).
    expect(addNote).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote.mock.calls[0][0]).toBe("server-2");
    const entries = updateNote.mock.calls[0][1] as LifeEntry[];
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "loved" });
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "keep me" });
  });

  it("add-editor save routes to update when a note landed mid-edit (no double-create)", async () => {
    const user = userEvent.setup();
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);

    // Open the add-editor while the caller has no note, and type a draft.
    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    await user.type(within(editor).getByRole("textbox"), "my new note");

    // Scott's note lands via the mirror mid-edit — Map mutated in place, so the
    // editor stays mounted (memoized `mine` still undefined) but live state now
    // has the note. The onSave closure captured `existing=undefined` at render.
    injectNoteInPlace(
      note("server-3", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
    );

    await user.click(within(editor).getByText("Save"));

    // The save must re-select live state and UPDATE the landed note (merging the
    // typed text with its existing verdict), never addNote a duplicate row.
    expect(addNote).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote.mock.calls[0][0]).toBe("server-3");
    const entries = updateNote.mock.calls[0][1] as LifeEntry[];
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "my new note" });
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "loved" });
  });
});

describe("NotesThread — day subject", () => {
  it("filters notes by the composite day subjectId", () => {
    setStateNotes([
      note("d1", "scott", "day", "trip1:2026-06-01", [{ name: "text", type: "text", value: "great day" }]),
      note("d2", "angela", "day", "trip1:2026-06-02", [{ name: "text", type: "text", value: "other day" }]),
    ]);
    render(<NotesThread subjectType="day" subjectId="trip1:2026-06-01" />);
    expect(screen.getByText(/great day/)).toBeTruthy();
    expect(screen.queryByText(/other day/)).toBeNull();
  });
});
