/**
 * The per-user notes thread. Notes are independent entries: a user may leave
 * MULTIPLE notes on the same subject. A rating (verdict) is an optional field
 * composed INSIDE a note (activity subjects only) — there is no standalone
 * tap-to-rate and no single "your reaction" card. "Add a note" is always
 * available to the caller; adding always CREATES a new note, editing updates
 * that one note by id, and delete removes only that id.
 *
 * Presentation: the thread is COLLAPSED behind a compact trigger button. The
 * note cards + composer mount only once the trigger opens the modal. The
 * trigger summarises state at-a-glance (the caller's own verdict glyph + a note
 * count for activities; a "Notes"/"Journal" label + count for day/trip).
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

/** Open the collapsed thread's modal by clicking its trigger button. */
async function openThread(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("notes-trigger"));
}

describe("NotesThread — collapsed by default", () => {
  it("renders only a trigger button; note cards + composer are NOT in the DOM until opened", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "loved the view" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);

    // The trigger is present...
    expect(screen.getByTestId("notes-trigger")).toBeTruthy();
    // ...but the thread body (note card + add affordance) is not yet mounted.
    expect(screen.queryByTestId("note-n1")).toBeNull();
    expect(screen.queryByTestId("note-add")).toBeNull();
    expect(screen.queryByText(/loved the view/)).toBeNull();
  });

  it("the trigger is present even with zero notes (so the first note can be added)", () => {
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    expect(screen.getByTestId("notes-trigger")).toBeTruthy();
  });

  it("clicking the trigger opens the modal: existing notes + composer become visible", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "loved the view" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);

    await openThread(user);
    expect(screen.getByTestId("note-n1")).toBeTruthy();
    expect(screen.getByText(/loved the view/)).toBeTruthy();
    expect(screen.getByTestId("note-add")).toBeTruthy();
  });
});

describe("NotesThread — trigger summary reflects state", () => {
  it("shows the caller's own verdict glyph when they have a rated note", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "verdict", type: "text", value: "loved" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const trigger = screen.getByTestId("notes-trigger");
    // ❤️ is the loved glyph (reused from VerdictButtons).
    expect(within(trigger).getByText("❤️")).toBeTruthy();
  });

  it("shows a note count when notes exist", () => {
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "a" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "b" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    expect(within(screen.getByTestId("notes-trigger")).getByText("2")).toBeTruthy();
  });

  it("shows a neutral 'Feedback' affordance when there are no notes and no rating", () => {
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    expect(within(screen.getByTestId("notes-trigger")).getByText(/Feedback/i)).toBeTruthy();
  });

  it("only the CALLER's own verdict drives the glyph — not another author's", () => {
    setStateNotes([
      note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    const trigger = screen.getByTestId("notes-trigger");
    // No own rating → neutral label, not Angela's ⏭️.
    expect(within(trigger).queryByText("⏭️")).toBeNull();
  });

  it("day trigger shows a 'Notes' label and no verdict glyph", () => {
    setStateNotes([
      note("d1", "scott", "day", "trip1:2026-06-01", [{ name: "verdict", type: "text", value: "loved" }]),
    ]);
    render(<NotesThread subjectType="day" subjectId="trip1:2026-06-01" />);
    const trigger = screen.getByTestId("notes-trigger");
    expect(within(trigger).getByText(/Notes|Journal/i)).toBeTruthy();
    expect(within(trigger).queryByText("❤️")).toBeNull();
  });
});

describe("NotesThread — rendering (inside the opened modal)", () => {
  it("renders every note with its author's name, all cross-visible", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "loved the view" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "too crowded" }], "2026-06-02T00:00:00Z"),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    await openThread(user);
    expect(screen.getByText("Scott")).toBeTruthy();
    expect(screen.getByText("Angela")).toBeTruthy();
    expect(screen.getByText(/loved the view/)).toBeTruthy();
    expect(screen.getByText(/too crowded/)).toBeTruthy();
  });

  it("shows edit/delete affordances ONLY on the current user's own notes", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }]),
      note("n2", "angela", "activity", "act1", [{ name: "notes", type: "text", value: "theirs" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    await openThread(user);
    const scottRow = screen.getByTestId("note-n1");
    const angelaRow = screen.getByTestId("note-n2");
    expect(within(scottRow).queryByTestId("note-edit")).not.toBeNull();
    expect(within(scottRow).queryByTestId("note-delete")).not.toBeNull();
    expect(within(angelaRow).queryByTestId("note-edit")).toBeNull();
    expect(within(angelaRow).queryByTestId("note-delete")).toBeNull();
  });

  it("renders createdBy==='' as Imported, unattributed and non-editable", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n0", "", "activity", "act1", [{ name: "notes", type: "text", value: "legacy note" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    await openThread(user);
    const row = screen.getByTestId("note-n0");
    expect(within(row).getByText(/Imported/i)).toBeTruthy();
    expect(within(row).queryByTestId("note-edit")).toBeNull();
    expect(within(row).queryByTestId("note-delete")).toBeNull();
    expect(screen.getByText(/legacy note/)).toBeTruthy();
  });

  it("always offers an add-note affordance, even when the caller already has a note", async () => {
    const user = userEvent.setup();
    setStateNotes([note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "mine" }])]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    await openThread(user);
    expect(screen.queryByTestId("note-add")).not.toBeNull();
  });
});

describe("NotesThread — multiple notes per user", () => {
  it("adding a second note for the same activity creates a NEW note (no upsert)", async () => {
    const user = userEvent.setup();
    setStateNotes([note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "first visit" }])]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    await user.type(within(editor).getByRole("textbox"), "second visit, different");
    await user.click(within(editor).getByText("Save"));

    // A brand-new note, NOT an update of the existing one.
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(updateNote).not.toHaveBeenCalled();
    const [, , , , entries] = addNote.mock.calls[0];
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "second visit, different" });
  });

  it("a note can be saved rating-only (no text)", async () => {
    const user = userEvent.setup();
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    await user.click(within(editor).getByTestId("verdict-loved"));
    await user.click(within(editor).getByText("Save"));

    expect(addNote).toHaveBeenCalledTimes(1);
    const entries = addNote.mock.calls[0][4] as LifeEntry[];
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "loved" });
    expect(entries.some((e) => e.name === "notes")).toBe(false);
  });

  it("a note can be saved text-only (no rating)", async () => {
    const user = userEvent.setup();
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    await user.type(within(editor).getByRole("textbox"), "just words");
    await user.click(within(editor).getByText("Save"));

    expect(addNote).toHaveBeenCalledTimes(1);
    const entries = addNote.mock.calls[0][4] as LifeEntry[];
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "just words" });
    expect(entries.some((e) => e.name === "verdict")).toBe(false);
  });

  it("an all-empty compose is rejected — no addNote", async () => {
    const user = userEvent.setup();
    setStateNotes([]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    // No rating, no text → Save is disabled, so nothing can be created.
    const saveBtn = within(editor).getByText("Save").closest("button");
    expect(saveBtn?.disabled).toBe(true);

    // Typing then clearing leaves it empty again — still no create path.
    const textbox = within(editor).getByRole("textbox");
    await user.type(textbox, "x");
    await user.clear(textbox);
    expect((within(editor).getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(addNote).not.toHaveBeenCalled();
  });
});

describe("NotesThread — editing isolates to one note", () => {
  it("editing one of the user's two notes updates only that id (text + rating)", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "first" }], "2026-06-01T00:00:00Z"),
      note("n2", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "second" }], "2026-06-02T00:00:00Z"),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);

    const n1Card = screen.getByTestId("note-n1");
    await user.click(within(n1Card).getByTestId("note-edit"));
    // The editor replaces that card's body. Add a rating and change text.
    const n1Editing = screen.getByTestId("note-n1");
    await user.click(within(n1Editing).getByTestId("verdict-liked"));
    const textbox = within(n1Editing).getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "first edited");
    await user.click(within(n1Editing).getByText("Save"));

    expect(addNote).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateNote.mock.calls[0][0]).toBe("n1");
    const entries = updateNote.mock.calls[0][1] as LifeEntry[];
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "first edited" });
    expect(entries).toContainEqual({ name: "verdict", type: "text", value: "liked" });
  });

  it("deleting one of several own notes removes only that id", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n1", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "first" }]),
      note("n2", "scott", "activity", "act1", [{ name: "notes", type: "text", value: "second" }], "2026-06-02T00:00:00Z"),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" />);
    await openThread(user);

    const n2Card = screen.getByTestId("note-n2");
    await user.click(within(n2Card).getByTestId("note-delete"));
    // Confirm the popconfirm.
    await user.click(screen.getByText("Delete"));

    expect(deleteNote).toHaveBeenCalledTimes(1);
    expect(deleteNote.mock.calls[0][0]).toBe("n2");
  });
});

describe("NotesThread — others' ratings are read-only", () => {
  it("another author's verdict renders as a read-only tag, no editable picker", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n2", "angela", "activity", "act1", [{ name: "verdict", type: "text", value: "skip" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);
    const angelaCard = screen.getByTestId("note-n2");
    expect(within(angelaCard).getByText(/would skip/i)).toBeTruthy();
    expect(within(angelaCard).queryByTestId("verdict-skip")).toBeNull();
    expect(within(angelaCard).queryByTestId("verdict-loved")).toBeNull();
  });

  it("an imported note's verdict is read-only, not an editable picker", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("n0", "", "activity", "act1", [{ name: "verdict", type: "text", value: "meh" }]),
    ]);
    render(<NotesThread subjectType="activity" subjectId="act1" showVerdict />);
    await openThread(user);
    const importedCard = screen.getByTestId("note-n0");
    expect(within(importedCard).getByText(/meh/i)).toBeTruthy();
    expect(within(importedCard).queryByTestId("verdict-meh")).toBeNull();
  });
});

describe("NotesThread — day subject", () => {
  it("filters notes by the composite day subjectId", async () => {
    const user = userEvent.setup();
    setStateNotes([
      note("d1", "scott", "day", "trip1:2026-06-01", [{ name: "text", type: "text", value: "great day" }]),
      note("d2", "angela", "day", "trip1:2026-06-02", [{ name: "text", type: "text", value: "other day" }]),
    ]);
    render(<NotesThread subjectType="day" subjectId="trip1:2026-06-01" />);
    await openThread(user);
    expect(screen.getByText(/great day/)).toBeTruthy();
    expect(screen.queryByText(/other day/)).toBeNull();
  });

  it("day composer has highlight + mood but no rating picker; allows a second note", async () => {
    const user = userEvent.setup();
    // Caller already has a day note — adding another is still allowed (multiple OK).
    setStateNotes([note("d1", "scott", "day", "trip1:2026-06-01", [{ name: "text", type: "text", value: "first" }])]);
    render(<NotesThread subjectType="day" subjectId="trip1:2026-06-01" />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    // No activity rating picker on a day composer.
    expect(within(editor).queryByTestId("verdict-loved")).toBeNull();
    // Highlight input + a mood Rate exist.
    expect(within(editor).getByPlaceholderText(/Best moment/i)).toBeTruthy();

    await user.type(within(editor).getAllByRole("textbox")[1], "second day note");
    await user.click(within(editor).getByText("Save"));

    expect(addNote).toHaveBeenCalledTimes(1);
    const [, subjectType, , , entries] = addNote.mock.calls[0];
    expect(subjectType).toBe("day");
    expect(entries).toContainEqual({ name: "text", type: "text", value: "second day note" });
  });
});

describe("NotesThread — trip subject", () => {
  it("trip composer is text-only (no rating, no highlight/mood)", async () => {
    const user = userEvent.setup();
    setStateNotes([]);
    render(<NotesThread subjectType="trip" subjectId="trip1" />);
    await openThread(user);

    await user.click(screen.getByTestId("note-add"));
    const editor = screen.getByTestId("note-add-editor");
    expect(within(editor).queryByTestId("verdict-loved")).toBeNull();
    expect(within(editor).queryByPlaceholderText(/Best moment/i)).toBeNull();

    await user.type(within(editor).getByRole("textbox"), "trip thoughts");
    await user.click(within(editor).getByText("Save"));

    expect(addNote).toHaveBeenCalledTimes(1);
    const [, subjectType, , , entries] = addNote.mock.calls[0];
    expect(subjectType).toBe("trip");
    expect(entries).toContainEqual({ name: "notes", type: "text", value: "trip thoughts" });
  });
});
