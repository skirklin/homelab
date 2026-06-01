/**
 * P3 — the cross-trackable quick-log row. Renders the most-frecent actions +
 * pins across all non-hidden trackables; one tap logs the payload against the
 * right trackable. Hidden trackables never surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEvent, LifeEntry } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({ message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }),
    useLifeBackend: () => ({ addEvent }),
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

const edibles: LifeManifestTrackable = {
  id: "edibles",
  label: "Edibles",
  fields: [{ key: "dose", type: "number", unit: "mg" }],
};
const coffee: LifeManifestTrackable = {
  id: "coffee",
  label: "Coffee",
  fields: [{ key: "volume", type: "number", unit: "oz" }],
};
const secret: LifeManifestTrackable = {
  id: "secret",
  label: "Secret",
  hidden: true,
  fields: [{ key: "count", type: "number", unit: "ct" }],
};

beforeEach(() => addEvent.mockClear());

function renderRow(trackables: LifeManifestTrackable[], entries: LifeEvent[]) {
  return render(
    <GlobalQuickRow trackables={trackables} entries={entries} userId="user1" logId="log1" />,
  );
}

describe("GlobalQuickRow", () => {
  it("renders cross-trackable frecent actions, labelled by trackable", () => {
    renderRow([edibles, coffee], [
      ev("edibles", num("dose", 5, "mg"), 1),
      ev("edibles", num("dose", 5, "mg"), 2),
      ev("coffee", num("volume", 8, "oz"), 3),
    ]);
    const chips = screen.getAllByTestId("global-quick-chip");
    const text = chips.map((c) => c.textContent ?? "");
    expect(text.some((t) => t.includes("Edibles"))).toBe(true);
    expect(text.some((t) => t.includes("Coffee"))).toBe(true);
  });

  it("one tap logs the exact payload against the right trackable", async () => {
    const user = userEvent.setup();
    renderRow([edibles], [
      ev("edibles", num("dose", 5, "mg"), 1),
      ev("edibles", num("dose", 5, "mg"), 2),
    ]);
    const chip = screen.getAllByTestId("global-quick-chip")[0];
    await user.click(chip);
    expect(addEvent).toHaveBeenCalledTimes(1);
    const c = addEvent.mock.calls[0];
    expect(c[0]).toBe("log1");
    expect(c[1]).toBe("edibles");
    expect(c[2]).toEqual(num("dose", 5, "mg"));
  });

  it("excludes hidden trackables", () => {
    renderRow([secret, coffee], [
      ev("secret", num("count", 1, "ct"), 1),
      ev("secret", num("count", 1, "ct"), 2),
      ev("coffee", num("volume", 8, "oz"), 3),
    ]);
    const text = screen.getAllByTestId("global-quick-chip").map((c) => c.textContent ?? "");
    expect(text.every((t) => !t.includes("Secret"))).toBe(true);
  });

  it("renders nothing when there's no history and no pins", () => {
    renderRow([edibles, coffee], []);
    expect(screen.queryByTestId("global-quick-row")).toBeNull();
  });

  it("surfaces pins first", () => {
    const withPin: LifeManifestTrackable = {
      ...coffee,
      pinned: [{ label: "12 oz", entries: num("volume", 12, "oz") }],
    };
    renderRow([edibles, withPin], [
      ev("edibles", num("dose", 5, "mg"), 1),
    ]);
    const chips = screen.getAllByTestId("global-quick-chip");
    // First chip is the Coffee pin.
    expect(within(chips[0]).getByText("Coffee")).toBeInTheDocument();
    expect(chips[0].textContent).toContain("12 oz");
  });
});
