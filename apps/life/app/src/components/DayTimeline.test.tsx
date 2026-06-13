/**
 * The inline "Today" timeline on the dashboard: a chronological, newest-first
 * peek at the viewed day's events. Read surface + a tap that resolves a row's
 * trackable to its shape and opens that shape's sheet. Unknown subjectIds
 * degrade to the raw id and are non-interactive; session events render as
 * labeled, non-interactive rows; an empty day shows a quiet hint.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { LifeManifestTrackable, LifeEvent, LifeEntry } from "@homelab/backend";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
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
  const onOpenShape = props.onOpenShape ?? vi.fn();
  render(
    <MemoryRouter>
      <DayTimeline
        trackables={props.trackables ?? TRACKABLES}
        events={props.events ?? []}
        day={props.day ?? TODAY}
        journalTarget={props.journalTarget ?? "journal"}
        onOpenShape={onOpenShape}
      />
    </MemoryRouter>,
  );
  return { onOpenShape };
}

describe("DayTimeline", () => {
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

  it("tapping a row resolves the trackable's shape and opens that sheet", async () => {
    const user = userEvent.setup();
    const { onOpenShape } = renderTimeline({
      events: [ev("run", num("duration", 30, "min"), TODAY, 17)],
    });
    await user.click(screen.getByTestId("day-timeline-row"));
    expect(onOpenShape).toHaveBeenCalledWith("did");
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

  it("degrades an unknown subjectId to the raw id and makes the row non-interactive", async () => {
    const user = userEvent.setup();
    const { onOpenShape } = renderTimeline({
      events: [ev("deleted_thing", num("amount", 1, "ct"), TODAY, 9)],
    });
    const row = screen.getByTestId("day-timeline-row");
    expect(row).toHaveTextContent("deleted_thing");
    expect(row).toBeDisabled();
    await user.click(row);
    expect(onOpenShape).not.toHaveBeenCalled();
  });

  it("renders session events as labeled, non-interactive rows", async () => {
    const user = userEvent.setup();
    const { onOpenShape } = renderTimeline({
      events: [ev("morning_session", [{ name: "intention", type: "text", value: "ship it" }], TODAY, 7)],
    });
    const row = screen.getByTestId("day-timeline-row");
    expect(row).toHaveTextContent("Morning session");
    expect(row).toBeDisabled();
    await user.click(row);
    expect(onOpenShape).not.toHaveBeenCalled();
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
