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
import type { LogEvent, LifeLog } from "../types";
import { getDateString } from "../lib/useSelectedDate";

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

function Seed({ entries, log }: { entries: LogEvent[]; log?: LifeLog }) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    if (log) dispatch({ type: "SET_LOG", log });
    dispatch({ type: "SET_ENTRIES", entries });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderJournal(entries: LogEvent[], opts?: { initialEntries?: string[]; log?: LifeLog }) {
  return render(
    <MemoryRouter initialEntries={opts?.initialEntries ?? ["/journal"]}>
      <LifeProvider>
        <Seed entries={entries} log={opts?.log} />
        <Journal />
      </LifeProvider>
    </MemoryRouter>,
  );
}

// Build the `?date=` value from the SAME user-tz day key the Journal buckets
// measurements by (getDateString → dayKey(d, userTz)). Using the shared helper
// rather than a local device-local YYYY-MM-DD is the tz-correctness assertion:
// the param we navigate to and the day the component groups events under are
// computed by one regime, so a near-midnight event can't land in the param's
// day while the component buckets it on the next/prev day.
function dateKeyOf(d: Date): string {
  return getDateString(d);
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
    // (a) The delete handler ran against the tapped event.
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith(entry.id));
    // (b) The modal closed. AntD's leave motion never *completes* under
    // happy-dom (no CSS transitionend fires, so the portal subtree lingers),
    // but the `open=false` re-render DOES flip the dialog into its leave
    // transition — the `ant-zoom-leave` class is the honest "closing" signal.
    // It is absent while the modal is open, so the assertion still has teeth.
    await waitFor(() =>
      expect(document.querySelector(".ant-modal")).toHaveClass("ant-zoom-leave"),
    );
  });

  it("with ?date=, shows that day's measurements grouped by trackable", async () => {
    const log: LifeLog = {
      id: "log1",
      sampleSchedule: null,
      manifest: {
        trackables: [
          { id: "weight", label: "Weight", shape: "took", defaultUnit: "lb" },
        ],
      },
      randomSamplingEnabled: false,
      coachEnabled: true,
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-01T00:00:00Z",
    };
    renderJournal(
      [ev("weight", [{ name: "amount", type: "number", value: 180, unit: "lb" }], TODAY)],
      { initialEntries: [`/journal?date=${dateKeyOf(TODAY)}`], log },
    );
    const section = await screen.findByTestId("journal-measurements");
    expect(section).toHaveTextContent("Weight");
    // The measurement renders as an editable entry row (same component the
    // dashboard timeline uses).
    expect(screen.getByTestId("entry-row")).toBeInTheDocument();
  });

  it("without ?date=, the measurements section is absent", async () => {
    renderJournal([
      ev("weight", [{ name: "amount", type: "number", value: 180, unit: "lb" }], TODAY),
    ]);
    // Give the effect a tick to flush before asserting absence.
    await screen.findByText(/New entry/);
    expect(screen.queryByTestId("journal-measurements")).not.toBeInTheDocument();
  });

  // A per-item run child — carries labels.view + labels.view_run.
  const runIso = TODAY.toISOString();
  const labelled = (subjectId: string, entries: LifeEntry[]): LifeEvent => {
    const e = ev(subjectId, entries, TODAY);
    e.labels = { source: "manual", view: "morning", view_run: runIso };
    return e;
  };

  it("session run cards are NOT tappable (no journal-entry-card)", async () => {
    renderJournal([
      labelled("daily_intention", [{ name: "note", type: "text", value: "ship it" }]),
    ]);
    // The run renders its prompt value, but as a non-interactive card.
    await screen.findByText("ship it");
    expect(screen.queryByTestId("journal-entry-card")).not.toBeInTheDocument();
  });

  it("renders a PER-ITEM morning run with its prompts + values", async () => {
    renderJournal([
      labelled("gratitude", [{ name: "note", type: "text", value: "the coffee" }]),
      labelled("daily_intention", [{ name: "note", type: "text", value: "ship the cutover" }]),
      labelled("energy", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]),
    ]);
    // Prompt labels come from DEFAULT_VIEW_TRACKABLES via toJournalRun.
    expect(await screen.findByText("What are you grateful for?")).toBeInTheDocument();
    expect(screen.getByText("the coffee")).toBeInTheDocument();
    expect(screen.getByText("What's the plan for today?")).toBeInTheDocument();
    expect(screen.getByText("ship the cutover")).toBeInTheDocument();
    // Energy rating renders as a pill.
    expect(screen.getByText("4 / 5")).toBeInTheDocument();
    // It's a session run card — non-interactive (not a freeform journal card).
    expect(screen.queryByTestId("journal-entry-card")).not.toBeInTheDocument();
  });
});
