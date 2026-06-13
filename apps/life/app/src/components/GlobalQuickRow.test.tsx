/**
 * The global quick-row — the dashboard's primary input surface. Renders ALL
 * pins (vocab order) then global frecency fill; one tap replays the exact
 * payload (subjectId + entries + labels) as a NEW event. Hidden trackables
 * never surface. Logging goes through useLogEvent (append + Undo toast).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEvent, LifeEntry } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");
const deleteEvent = vi.fn().mockResolvedValue(undefined);
const messageOpen = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: messageOpen, destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent, deleteEvent }),
  };
});

import { GlobalQuickRow } from "./GlobalQuickRow";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], daysAgo: number, labels?: Record<string, string>): LifeEvent {
  counter += 1;
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
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
const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];

const edibles: LifeManifestTrackable = { id: "edibles", label: "Edibles", shape: "took", defaultUnit: "mg" };
const coffee: LifeManifestTrackable = { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz" };
const secret: LifeManifestTrackable = { id: "secret", label: "Secret", shape: "happened", hidden: true };

describe("GlobalQuickRow", () => {
  beforeEach(() => {
    addEvent.mockClear();
    messageOpen.mockClear();
  });

  it("renders nothing with no history and no pins", () => {
    render(
      <GlobalQuickRow trackables={[edibles, coffee]} events={[]} userId="u1" logId="log1" />,
    );
    expect(screen.queryByTestId("global-quick-row")).not.toBeInTheDocument();
  });

  it("renders frecent chips across trackables; hidden things never surface", () => {
    const events = [
      ev("edibles", num("dose", 5, "mg"), 1),
      ev("edibles", num("dose", 5, "mg"), 2),
      ev("coffee", num("volume", 8, "oz"), 1),
      ev("secret", num("count", 1, "ct"), 0),
      ev("secret", num("count", 1, "ct"), 0),
    ];
    render(
      <GlobalQuickRow trackables={[edibles, coffee, secret]} events={events} userId="u1" logId="log1" />,
    );
    const chips = screen.getAllByTestId("global-quick-chip");
    expect(chips.length).toBe(2);
    expect(screen.getByText("Edibles")).toBeInTheDocument();
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });

  it("renders ALL pins (vocab order) ahead of frecency fill", () => {
    const pinnedCoffee: LifeManifestTrackable = {
      ...coffee,
      pinned: [{ label: "16 oz", entries: num("volume", 16, "oz") }],
    };
    const events = [
      ev("edibles", num("dose", 5, "mg"), 0),
      ev("edibles", num("dose", 5, "mg"), 1),
    ];
    render(
      <GlobalQuickRow trackables={[edibles, pinnedCoffee]} events={events} userId="u1" logId="log1" />,
    );
    const chips = screen.getAllByTestId("global-quick-chip");
    // Pin first even though edibles has the higher frecency score.
    expect(chips[0]).toHaveTextContent("Coffee");
    expect(chips[0]).toHaveTextContent("16 oz");
    expect(chips[1]).toHaveTextContent("Edibles");
  });

  it("tapping a chip replays the exact payload (subjectId + entries + labels) at the given timestamp", async () => {
    const user = userEvent.setup();
    const ts = new Date("2026-05-20T12:00:00");
    const events = [
      ev("edibles", num("dose", 5, "mg"), 1, { category: "evening" }),
      ev("edibles", num("dose", 5, "mg"), 2, { category: "evening" }),
    ];
    render(
      <GlobalQuickRow trackables={[edibles]} events={events} userId="u1" logId="log1" timestamp={ts} />,
    );
    await user.click(screen.getAllByTestId("global-quick-chip")[0]);
    expect(addEvent).toHaveBeenCalledWith(
      "log1",
      "edibles",
      num("dose", 5, "mg"),
      "u1",
      { timestamp: ts, labels: { category: "evening" } },
    );
    // Post-log toast (with Undo) was opened.
    expect(messageOpen).toHaveBeenCalled();
  });

  it("chips are disabled until the log id is known", () => {
    const events = [ev("edibles", num("dose", 5, "mg"), 1)];
    render(
      <GlobalQuickRow trackables={[edibles]} events={events} userId="u1" logId={undefined} />,
    );
    expect(screen.getAllByTestId("global-quick-chip")[0]).toBeDisabled();
  });
});
