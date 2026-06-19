/**
 * The inline "Today" timeline on the dashboard: a chronological, newest-first
 * peek at the viewed day's events. Read surface + a tap that opens the
 * single-event edit modal for that exact event. Session events render as
 * labeled, NON-interactive rows; unknown subjectIds degrade to the raw id but
 * ARE editable (the event still has entries worth editing/deleting); an empty
 * day shows a quiet hint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { LifeManifestTrackable, LifeEvent, LifeEntry } from "@homelab/backend";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

const deleteEvent = vi.fn().mockResolvedValue(undefined);
const updateEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: vi.fn(), destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ deleteEvent, updateEvent }),
  };
});

import { DayTimeline } from "./DayTimeline";

let counter = 0;
/** Build an event at a fixed clock time on `day`. */
function ev(subjectId: string, entries: LifeEntry[], day: Date, hour: number, minute = 0): LifeEvent {
  counter += 1;
  const ts = new Date(day);
  ts.setHours(hour, minute, 0, 0);
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
const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];

const coffee: LifeManifestTrackable = { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz" };
const run: LifeManifestTrackable = { id: "run", label: "Run", shape: "did" };
const poop: LifeManifestTrackable = { id: "poop", label: "Poop", shape: "happened" };
const TRACKABLES = [coffee, run, poop];

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

function renderTimeline(props: Partial<React.ComponentProps<typeof DayTimeline>> = {}) {
  render(
    <MemoryRouter>
      <DayTimeline
        trackables={props.trackables ?? TRACKABLES}
        events={props.events ?? []}
        day={props.day ?? TODAY}
        journalTarget={props.journalTarget ?? "journal"}
      />
    </MemoryRouter>,
  );
}

describe("DayTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters to the viewed day and sorts newest-first", () => {
    const other = new Date(TODAY);
    other.setDate(other.getDate() - 3);
    renderTimeline({
      events: [
        ev("coffee", num("amount", 16, "oz"), TODAY, 8),
        ev("run", num("duration", 30, "min"), TODAY, 17),
        ev("coffee", num("amount", 12, "oz"), other, 9), // different day → excluded
      ],
    });
    const rows = screen.getAllByTestId("day-timeline-row");
    expect(rows).toHaveLength(2);
    // Newest first: the 5pm Run row precedes the 8am Coffee row.
    expect(rows[0]).toHaveTextContent("Run");
    expect(rows[1]).toHaveTextContent("Coffee");
  });

  it("renders the value summary the same way the cards do", () => {
    renderTimeline({
      events: [
        ev("coffee", num("amount", 16, "oz"), TODAY, 8),
        ev("poop", num("count", 1, "ct"), TODAY, 7),
      ],
    });
    expect(screen.getByText("16 oz")).toBeInTheDocument();
    expect(screen.getByText("×1")).toBeInTheDocument(); // happened → count summary
  });

  it("tapping a row opens the single-event edit modal for that event", async () => {
    const user = userEvent.setup();
    renderTimeline({
      events: [ev("run", num("duration", 30, "min"), TODAY, 17)],
    });
    await user.click(screen.getByTestId("day-timeline-row"));
    // Modal title carries the thing label + time; the inline editor row shows.
    expect(await screen.findByText(/Edit · Run/)).toBeInTheDocument();
    expect(screen.getByTestId("entry-row")).toBeInTheDocument();
  });

  it("editing a value in the modal calls updateEvent with the right id", async () => {
    const user = userEvent.setup();
    const event = ev("run", num("duration", 30, "min"), TODAY, 17);
    renderTimeline({ events: [event] });
    await user.click(screen.getByTestId("day-timeline-row"));
    await screen.findByTestId("entry-row");
    // Bump the rated/duration field — duration editor surfaces a spinbutton.
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "45");
    await waitFor(() => expect(updateEvent).toHaveBeenCalled(), { timeout: 2000 });
    expect(updateEvent.mock.calls[0][0]).toBe(event.id);
  });

  it("deleting from the modal calls deleteEvent and closes the modal", async () => {
    const user = userEvent.setup();
    const event = ev("run", num("duration", 30, "min"), TODAY, 17);
    renderTimeline({ events: [event] });
    await user.click(screen.getByTestId("day-timeline-row"));
    await screen.findByTestId("entry-row");
    await user.click(screen.getByRole("button", { name: "Delete entry" }));
    // (a) The delete handler ran against the tapped event.
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith(event.id));
    // (b) The modal closed. AntD's leave motion never *completes* under
    // happy-dom (no CSS transitionend fires, so the portal subtree lingers),
    // but the `open=false` re-render DOES flip the dialog into its leave
    // transition — the `ant-zoom-leave` class is the honest "closing" signal.
    // It is absent while the modal is open, so the assertion still has teeth.
    await waitFor(() =>
      expect(document.querySelector(".ant-modal")).toHaveClass("ant-zoom-leave"),
    );
  });

  it("caps at 7 rows and surfaces a '+N more' footer", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev("coffee", num("amount", 8, "oz"), TODAY, 6 + i),
    );
    renderTimeline({ events });
    expect(screen.getAllByTestId("day-timeline-row")).toHaveLength(7);
    expect(screen.getByTestId("day-timeline-footer")).toHaveTextContent("+3 more");
  });

  it("footer with no overflow still links to the Journal", async () => {
    const user = userEvent.setup();
    renderTimeline({
      events: [ev("coffee", num("amount", 8, "oz"), TODAY, 8)],
      journalTarget: "journal?date=2026-06-12",
    });
    const footer = screen.getByTestId("day-timeline-footer");
    expect(footer).toHaveTextContent("See all in Journal");
    expect(footer).not.toHaveTextContent("more");
    await user.click(footer);
    expect(navigate).toHaveBeenCalledWith("journal?date=2026-06-12");
  });

  it("degrades an unknown subjectId to the raw id but keeps the row editable", async () => {
    const user = userEvent.setup();
    renderTimeline({
      events: [ev("deleted_thing", num("amount", 1, "ct"), TODAY, 9)],
    });
    const row = screen.getByTestId("day-timeline-row");
    expect(row).toHaveTextContent("deleted_thing");
    expect(row).not.toBeDisabled();
    await user.click(row);
    // The modal opens with the raw id as the label (degrade, don't drop).
    expect(await screen.findByText(/Edit · deleted_thing/)).toBeInTheDocument();
  });

  it("renders session events as labeled, non-interactive rows", async () => {
    const user = userEvent.setup();
    renderTimeline({
      events: [ev("morning_session", [{ name: "intention", type: "text", value: "ship it" }], TODAY, 7)],
    });
    const row = screen.getByTestId("day-timeline-row");
    expect(row).toHaveTextContent("Morning session");
    expect(row).toBeDisabled();
    await user.click(row);
    expect(screen.queryByTestId("entry-row")).not.toBeInTheDocument();
  });

  it("renders a PER-ITEM run as ONE non-interactive session row (children NOT shown individually)", () => {
    // Three per-item events correlated by labels.view/view_run — the new shape.
    const labelled = (subjectId: string, entries: LifeEntry[], runIso: string): LifeEvent => {
      const e = ev(subjectId, entries, TODAY, 7);
      e.labels = { source: "manual", view: "morning", view_run: runIso };
      e.timestamp = new Date(runIso);
      return e;
    };
    const runIso = (() => {
      const d = new Date(TODAY);
      d.setHours(7, 0, 0, 0);
      return d.toISOString();
    })();
    renderTimeline({
      events: [
        labelled("gratitude", [{ name: "note", type: "text", value: "coffee" }], runIso),
        labelled("daily_intention", [{ name: "note", type: "text", value: "ship it" }], runIso),
        labelled("energy", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], runIso),
      ],
    });
    const rows = screen.getAllByTestId("day-timeline-row");
    // Exactly ONE row — the session — not three per-item rows.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Morning session");
    expect(rows[0]).toBeDisabled();
  });

  it("dedups: a fat run + its per-item run on the same timestamp render as ONE row", () => {
    const runIso = (() => {
      const d = new Date(TODAY);
      d.setHours(7, 0, 0, 0);
      return d.toISOString();
    })();
    const fat = ev("morning_session", [{ name: "gratitude", type: "text", value: "coffee" }], TODAY, 7);
    fat.timestamp = new Date(runIso);
    const child = ev("gratitude", [{ name: "note", type: "text", value: "coffee" }], TODAY, 7);
    child.timestamp = new Date(runIso);
    child.labels = { source: "manual", view: "morning", view_run: runIso };
    renderTimeline({ events: [fat, child] });
    const rows = screen.getAllByTestId("day-timeline-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Morning session");
  });

  it("shows a quiet empty hint and no list when nothing was logged", () => {
    renderTimeline({ events: [] });
    expect(screen.queryByTestId("day-timeline-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("day-timeline-empty")).toHaveTextContent("Nothing logged today");
  });

  it("empty hint reads '…this day' when viewing a past day", () => {
    const past = new Date(TODAY);
    past.setDate(past.getDate() - 5);
    renderTimeline({ events: [], day: past });
    expect(screen.getByTestId("day-timeline-empty")).toHaveTextContent("Nothing logged this day");
  });

  it("header says 'Today's log' for the current day", () => {
    renderTimeline({ events: [ev("coffee", num("amount", 8, "oz"), TODAY, 8)] });
    const wrap = screen.getByTestId("day-timeline");
    expect(within(wrap).getByText("Today's log")).toBeInTheDocument();
  });
});
