/**
 * Journal — historical events grouped by day. Freeform journal entries are
 * tappable: tapping one opens the shared single-event edit modal (edit/delete
 * from history). Session entries (morning/evening/weekly) are composite prompt
 * entries, not single-shape events, so they stay non-interactive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { LifeEntry, LifeEvent } from "@homelab/backend";

const deleteEvent = vi.fn().mockResolvedValue(undefined);
const updateEvent = vi.fn().mockResolvedValue(undefined);
const addEvent = vi.fn().mockResolvedValue("evt1");

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "u1" }, loading: false }),
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: vi.fn(), destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ deleteEvent, updateEvent, addEvent }),
  };
});

import { Journal } from "./Journal";
import { LifeProvider, useLifeContext } from "../life-context";
import type { LogEntry } from "../types";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], ts: Date): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: ts,
    entries,
    createdBy: "u1",
    created: ts.toISOString(),
    updated: ts.toISOString(),
  };
}

function Seed({ entries }: { entries: LogEntry[] }) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    dispatch({ type: "SET_ENTRIES", entries });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderJournal(entries: LogEntry[]) {
  return render(
    <MemoryRouter>
      <LifeProvider>
        <Seed entries={entries} />
        <Journal />
      </LifeProvider>
    </MemoryRouter>,
  );
}

const TODAY = new Date();
TODAY.setHours(9, 0, 0, 0);

describe("Journal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tapping a freeform journal entry opens the edit modal for that event", async () => {
    const user = userEvent.setup();
    renderJournal([ev("journal", [{ name: "body", type: "text", value: "a calm day" }], TODAY)]);
    const card = await screen.findByTestId("journal-entry-card");
    await user.click(card);
    expect(await screen.findByText(/^Edit · /)).toBeInTheDocument();
    expect(screen.getByTestId("entry-row")).toBeInTheDocument();
  });

  it("deleting from the modal calls deleteEvent and closes the modal", async () => {
    const user = userEvent.setup();
    const entry = ev("journal", [{ name: "body", type: "text", value: "delete me" }], TODAY);
    renderJournal([entry]);
    await user.click(await screen.findByTestId("journal-entry-card"));
    await screen.findByTestId("entry-row");
    await user.click(screen.getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith(entry.id));
    await waitFor(() => expect(screen.queryByTestId("entry-row")).not.toBeInTheDocument());
  });

  it("session entries are NOT tappable (no journal-entry-card)", async () => {
    renderJournal([
      ev("morning_session", [{ name: "intention", type: "text", value: "ship it" }], TODAY),
    ]);
    // The session renders its prompt value, but as a non-interactive card.
    await screen.findByText("ship it");
    expect(screen.queryByTestId("journal-entry-card")).not.toBeInTheDocument();
  });
});
