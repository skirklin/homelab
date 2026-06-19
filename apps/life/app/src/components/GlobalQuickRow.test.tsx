/**
 * The Favorites quick-row — the Daily surface's one-tap log row. Renders ONLY
 * explicit favorites (pinned payloads, vocab order); there is NO frecency fill.
 * A tap replays the exact payload (subjectId + entries + labels) as a NEW event;
 * the ✕ un-favorites a chip inline. Empty → a quiet hint, not an empty bar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import type { LifeManifestTrackable, LifeEntry } from "@homelab/backend";
import { LifeProvider } from "../life-context";

const addEvent = vi.fn().mockResolvedValue("evt1");
const deleteEvent = vi.fn().mockResolvedValue(undefined);
const updateTrackable = vi.fn().mockResolvedValue({ trackables: [], views: [] });
const messageOpen = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: messageOpen, destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent, deleteEvent, updateTrackable }),
  };
});

import { GlobalQuickRow } from "./GlobalQuickRow";

const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];

const edibles: LifeManifestTrackable = { id: "edibles", label: "Edibles", shape: "took", defaultUnit: "mg" };
const coffee: LifeManifestTrackable = {
  id: "coffee",
  label: "Coffee",
  shape: "took",
  defaultUnit: "oz",
  pinned: [{ label: "16 oz", entries: num("amount", 16, "oz") }],
};
const secret: LifeManifestTrackable = {
  id: "secret",
  label: "Secret",
  shape: "happened",
  hidden: true,
  pinned: [{ label: "tap", entries: num("count", 1, "ct") }],
};

function renderRow(
  trackables: LifeManifestTrackable[],
  props: { logId?: string; timestamp?: Date; noLog?: boolean } = {},
) {
  return render(
    <AntApp>
      <MemoryRouter>
        <LifeProvider>
          <GlobalQuickRow
            trackables={trackables}
            userId="u1"
            logId={props.noLog ? undefined : props.logId ?? "log1"}
            timestamp={props.timestamp}
          />
        </LifeProvider>
      </MemoryRouter>
    </AntApp>,
  );
}

describe("GlobalQuickRow (favorites only)", () => {
  beforeEach(() => {
    addEvent.mockClear();
    updateTrackable.mockClear();
    messageOpen.mockClear();
  });

  it("shows a quiet hint (not an empty bar) when there are no favorites", () => {
    renderRow([edibles]);
    expect(screen.queryByTestId("global-quick-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("favorites-empty")).toBeInTheDocument();
  });

  it("renders ONLY pinned favorites — no frecency fill, hidden things never surface", () => {
    renderRow([edibles, coffee, secret]);
    const chips = screen.getAllByTestId("global-quick-chip");
    // Only coffee is pinned + visible; edibles has no pin, secret is hidden.
    expect(chips.length).toBe(1);
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.getByText("16 oz")).toBeInTheDocument();
    expect(screen.queryByText("Edibles")).not.toBeInTheDocument();
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });

  it("tapping a chip replays the exact payload at the given timestamp", async () => {
    const user = userEvent.setup();
    const ts = new Date("2026-05-20T12:00:00");
    renderRow([coffee], { timestamp: ts });
    await user.click(screen.getByTestId("global-quick-chip"));
    expect(addEvent).toHaveBeenCalledWith(
      "log1",
      "coffee",
      num("amount", 16, "oz"),
      "u1",
      { timestamp: ts, labels: undefined },
    );
    expect(messageOpen).toHaveBeenCalled();
  });

  it("the ✕ un-favorites a chip (drops it from the trackable's pins)", async () => {
    const user = userEvent.setup();
    renderRow([coffee]);
    await user.click(screen.getByTestId("global-quick-remove"));
    expect(updateTrackable).toHaveBeenCalledWith("log1", "coffee", { pinned: [] });
  });

  it("chips are disabled until the log id is known", () => {
    renderRow([coffee], { noLog: true });
    expect(screen.getByTestId("global-quick-chip")).toBeDisabled();
  });
});
