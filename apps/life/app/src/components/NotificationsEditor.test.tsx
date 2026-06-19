/**
 * NotificationsEditor — guards the Phase D id-scheme landmine: editing a
 * notification's TIME (or any field) must go through `updateNotification(id, …)`
 * with the id preserved, and a time-only edit must NOT drop the strategy's
 * `subsumes` / `weekday`. A rewritten id breaks the `reminder_state` double-fire
 * guard, so these assertions are load-bearing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import type { LifeNotification, LifeView } from "@homelab/backend";

const mockLifeBackend = {
  updateNotification: vi.fn().mockResolvedValue({ trackables: [] }),
  addNotification: vi.fn().mockResolvedValue({ trackables: [] }),
  removeNotification: vi.fn().mockResolvedValue({ trackables: [] }),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return { ...actual, useLifeBackend: () => mockLifeBackend };
});

import { NotificationsEditor } from "./NotificationsEditor";

const VIEWS: LifeView[] = [
  { id: "morning", title: "Morning", items: [] },
  { id: "evening", title: "Evening", items: [] },
  { id: "weekly", title: "Weekly review", items: [] },
];

function renderEditor(notifications: LifeNotification[]) {
  const applyManifest = vi.fn(async (work: () => Promise<unknown>) => work());
  render(
    <AntApp>
      <NotificationsEditor
        logId="log1"
        notifications={notifications}
        views={VIEWS}
        applyManifest={applyManifest as never}
      />
    </AntApp>,
  );
}

describe("NotificationsEditor — id-scheme landmine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a time edit preserves the id, cadence, weekday AND subsumes", async () => {
    const user = userEvent.setup();
    renderEditor([
      {
        id: "weekly-reminder",
        target: "weekly",
        strategy: { kind: "fixed", cadence: "weekly", time: "19:00", weekday: 0, subsumes: ["evening-reminder"] },
      },
    ]);

    // Open the TimePicker and pick a new time via the panel "Now"/typing path.
    const picker = screen.getByRole("textbox");
    await user.clear(picker);
    await user.type(picker, "20:30");
    await user.keyboard("{Enter}");

    expect(mockLifeBackend.updateNotification).toHaveBeenCalled();
    const [logId, id, patch] = mockLifeBackend.updateNotification.mock.calls.at(-1)!;
    expect(logId).toBe("log1");
    // id is NEVER rewritten — it keys reminder_state.
    expect(id).toBe("weekly-reminder");
    expect(patch.strategy).toMatchObject({
      kind: "fixed",
      cadence: "weekly",
      weekday: 0,
      subsumes: ["evening-reminder"],
      time: "20:30",
    });
  });

  it("clearing the time saves time:'' (never-deliver), keeping the rest", async () => {
    const user = userEvent.setup();
    renderEditor([
      {
        id: "morning-reminder",
        target: "morning",
        strategy: { kind: "fixed", cadence: "daily", time: "07:30" },
      },
    ]);

    // The allowClear "x" on the TimePicker.
    const clear = document.querySelector(".ant-picker-clear");
    expect(clear).toBeTruthy();
    await user.click(clear as Element);

    const [, id, patch] = mockLifeBackend.updateNotification.mock.calls.at(-1)!;
    expect(id).toBe("morning-reminder");
    expect(patch.strategy).toMatchObject({ kind: "fixed", cadence: "daily", time: "" });
  });
});
