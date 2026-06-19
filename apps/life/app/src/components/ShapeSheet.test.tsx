/**
 * The shape bottom sheet — the logging surface behind each shape card.
 *
 * Covers:
 *   - typeahead over vocab rows of the shape (case-insensitive)
 *   - picking a thing prefills last-used values (fallback: vocab defaults)
 *   - Log writes the CANONICAL entries[] for the shape (took/happened/rated)
 *   - typing an unknown name offers Create → slugifies + auto-registers a
 *     vocab row of this shape, then selects it
 *   - star-to-pin persists via updateTrackable(pinned)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import type { LifeEntry, LifeEvent, LifeManifest, TrackableShape } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");
const deleteEvent = vi.fn().mockResolvedValue(undefined);
const updateEvent = vi.fn().mockResolvedValue(undefined);
const addTrackable = vi.fn();
const updateTrackable = vi.fn();
const messageOpen = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: messageOpen, destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent, deleteEvent, updateEvent, addTrackable, updateTrackable }),
  };
});

import { ShapeSheet } from "./ShapeSheet";
import { LifeProvider, useLifeContext } from "../life-context";
import { useTrackables } from "../lib/trackables";
import type { LifeLog } from "../types";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], ts: Date, labels?: Record<string, string>): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: ts,
    entries,
    labels,
    createdBy: "u1",
    created: ts.toISOString(),
    updated: ts.toISOString(),
  };
}

function makeLog(manifest: LifeManifest): LifeLog {
  return {
    id: "log1",
    sampleSchedule: null,
    manifest,
    randomSamplingEnabled: false,
    coachEnabled: true,
    created: "2026-06-01T00:00:00Z",
    updated: "2026-06-01T00:00:00Z",
  };
}

const MANIFEST: LifeManifest = {
  trackables: [
    { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz", defaultAmount: 8 },
    { id: "vyvanse", label: "Vyvanse", shape: "took", defaultUnit: "mg", defaultAmount: 30 },
    { id: "floss", label: "Floss", shape: "happened" },
    { id: "mood", label: "Mood", shape: "rated" },
    { id: "hidden-took", label: "Hidden", shape: "took", hidden: true },
  ],
};

function Inner({ shape, events, day }: { shape: TrackableShape; events: LifeEvent[]; day: Date }) {
  const { dispatch } = useLifeContext();
  // Seed the log once; ShapeSheet's manifest mutations re-dispatch SET_LOG.
  useEffect(() => {
    dispatch({ type: "SET_LOG", log: makeLog(MANIFEST) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const trackables = useTrackables();
  return (
    <ShapeSheet
      shape={shape}
      onClose={() => {}}
      trackables={trackables}
      events={events}
      userId="u1"
      logId="log1"
      day={day}
    />
  );
}

function renderSheet(shape: TrackableShape, events: LifeEvent[] = [], day: Date = new Date()) {
  return render(
    <LifeProvider>
      <Inner shape={shape} events={events} day={day} />
    </LifeProvider>,
  );
}

describe("ShapeSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the shape's visible things and filters case-insensitively", async () => {
    const user = userEvent.setup();
    renderSheet("took");
    let things = await screen.findAllByTestId("shape-sheet-thing");
    expect(things.map((t) => t.textContent)).toEqual(["Coffee", "Vyvanse"]); // hidden excluded
    await user.type(screen.getByTestId("shape-sheet-search"), "COF");
    things = screen.getAllByTestId("shape-sheet-thing");
    expect(things).toHaveLength(1);
    expect(things[0]).toHaveTextContent("Coffee");
  });

  it("prefills last-used values and logs canonical took entries", async () => {
    const user = userEvent.setup();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // History uses the OLD entry name ("volume") — prefill must still find it.
    const events = [ev("coffee", [{ name: "volume", type: "number", value: 12, unit: "oz" }], yesterday)];
    renderSheet("took", events);

    await user.click((await screen.findAllByTestId("shape-sheet-thing"))[0]);
    // Last-used 12 beats the vocab default 8.
    const amount = screen.getByRole("spinbutton");
    expect(amount).toHaveValue("12");

    await user.click(screen.getByTestId("shape-sheet-log"));
    await waitFor(() => expect(addEvent).toHaveBeenCalled());
    const [logId, subjectId, entries] = addEvent.mock.calls[0];
    expect(logId).toBe("log1");
    expect(subjectId).toBe("coffee");
    expect(entries).toEqual([{ name: "amount", type: "number", value: 12, unit: "oz" }]);
  });

  it("falls back to vocab defaults when there is no history", async () => {
    const user = userEvent.setup();
    renderSheet("took");
    const things = await screen.findAllByTestId("shape-sheet-thing");
    await user.click(things[1]); // Vyvanse
    expect(screen.getByRole("spinbutton")).toHaveValue("30");
    await user.click(screen.getByTestId("shape-sheet-log"));
    await waitFor(() => expect(addEvent).toHaveBeenCalled());
    expect(addEvent.mock.calls[0][2]).toEqual([
      { name: "amount", type: "number", value: 30, unit: "mg" },
    ]);
  });

  it("happened logs count:1 ct and keeps the affordance after logging", async () => {
    const user = userEvent.setup();
    renderSheet("happened");
    await user.click((await screen.findAllByTestId("shape-sheet-thing"))[0]);
    await user.click(screen.getByTestId("shape-sheet-log"));
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    expect(addEvent.mock.calls[0][2]).toEqual([
      { name: "count", type: "number", value: 1, unit: "ct" },
    ]);
    // No affordance disappears: Log is still there; a second tap appends again.
    await user.click(screen.getByTestId("shape-sheet-log"));
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));
  });

  it("rated logs a rating entry with scale", async () => {
    const user = userEvent.setup();
    renderSheet("rated");
    await user.click((await screen.findAllByTestId("shape-sheet-thing"))[0]);
    await user.click(screen.getByRole("button", { name: "Rate 4" }));
    await user.click(screen.getByTestId("shape-sheet-log"));
    await waitFor(() => expect(addEvent).toHaveBeenCalled());
    expect(addEvent.mock.calls[0][1]).toBe("mood");
    expect(addEvent.mock.calls[0][2]).toEqual([
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });

  it("offers Create for an unknown name: slugifies, registers the vocab row, selects it", async () => {
    const user = userEvent.setup();
    addTrackable.mockImplementation(async (_logId: string, input: { id: string; label: string; shape: string }) => ({
      trackables: [
        ...MANIFEST.trackables,
        { id: input.id, label: input.label, shape: input.shape },
      ],
    }));
    renderSheet("took");
    await user.type(screen.getByTestId("shape-sheet-search"), "Trip Planning");
    await user.click(screen.getByTestId("shape-sheet-create"));
    await waitFor(() => expect(addTrackable).toHaveBeenCalledWith("log1", {
      id: "trip-planning",
      label: "Trip Planning",
      shape: "took",
    }));
    // The new thing is selected — its log form is up.
    await screen.findByText("Trip Planning");
    expect(screen.getByTestId("shape-sheet-log")).toBeInTheDocument();
  });

  it("star pins a frecent chip via updateTrackable(pinned)", async () => {
    const user = userEvent.setup();
    updateTrackable.mockResolvedValue(MANIFEST);
    const events = [
      ev("coffee", [{ name: "volume", type: "number", value: 12, unit: "oz" }], new Date()),
      ev("coffee", [{ name: "volume", type: "number", value: 12, unit: "oz" }], new Date()),
    ];
    renderSheet("took", events);
    await user.click((await screen.findAllByTestId("shape-sheet-thing"))[0]);
    const star = await screen.findByRole("button", { name: /^Pin / });
    await user.click(star);
    await waitFor(() => expect(updateTrackable).toHaveBeenCalled());
    const [, thingId, patch] = updateTrackable.mock.calls[0];
    expect(thingId).toBe("coffee");
    expect(patch.pinned).toEqual([
      { entries: [{ name: "volume", type: "number", value: 12, unit: "oz" }] },
    ]);
  });

  it("shows today's entries for the chosen thing with a delete affordance", async () => {
    const user = userEvent.setup();
    const events = [ev("coffee", [{ name: "volume", type: "number", value: 12, unit: "oz" }], new Date())];
    renderSheet("took", events);
    await user.click((await screen.findAllByTestId("shape-sheet-thing"))[0]);
    const row = await screen.findByTestId("entry-row");
    expect(row).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete entry" }));
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith(events[0].id));
  });
});
