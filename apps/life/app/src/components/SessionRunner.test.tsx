/**
 * The morning wizard, post-Fitbit-sync: sleep is NO LONGER prompted here (it
 * arrives from the Fitbit sync / is logged separately). The morning flow is
 * gratitude → intention → energy, and writes a single `morning_session` event;
 * it never writes a `sleep` event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useEffect, type ReactNode } from "react";

const addEvent = vi.fn().mockResolvedValue("evt1");
const messageInfo = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "u1" }, loading: false }),
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: messageInfo },
    }),
    useLifeBackend: () => ({ addEvent }),
    AppHeader: ({ title }: { title: ReactNode }) => <header>{title}</header>,
  };
});

// MorningUpkeepHeader fetches tasks — irrelevant here.
vi.mock("./MorningUpkeepHeader", () => ({ MorningUpkeepHeader: () => null }));

import { SessionRunner } from "./SessionRunner";
import { LifeProvider, useLifeContext } from "../life-context";
import type { LifeLog } from "../types";

const LOG: LifeLog = {
  id: "log1",
  sampleSchedule: null,
  manifest: { trackables: [] },
  randomSamplingEnabled: false,
  created: "2026-06-01T00:00:00Z",
  updated: "2026-06-01T00:00:00Z",
};

function Seed({ children }: { children: ReactNode }) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    dispatch({ type: "SET_LOG", log: LOG });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderMorning() {
  return render(
    <LifeProvider>
      <Seed>
        <MemoryRouter initialEntries={["/morning"]}>
          <Routes>
            <Route path="/" element={<div data-testid="dashboard" />} />
            <Route path="/morning" element={<SessionRunner sessionId="morning" />} />
          </Routes>
        </MemoryRouter>
      </Seed>
    </LifeProvider>,
  );
}

describe("SessionRunner morning wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("does not prompt for sleep — gratitude is the first step", async () => {
    renderMorning();
    await screen.findByText("What are you grateful for?");
    expect(screen.queryByText("How did you sleep?")).not.toBeInTheDocument();
  });

  it("writes a single morning_session event and never a sleep event", async () => {
    const user = userEvent.setup();
    renderMorning();

    // gratitude (text, optional): Skip.
    await screen.findByText("What are you grateful for?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    // intention (text, optional): Skip.
    await screen.findByText("What's the plan for today?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    // energy (rating): pick 4, Done.
    await screen.findByText("Energy");
    await user.click(screen.getByRole("button", { name: "4" }));
    await user.click(screen.getByRole("button", { name: /Done/ }));

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const call = addEvent.mock.calls[0];
    expect(call[1]).toBe("morning_session");
    expect(call[2]).toEqual([
      { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
    expect(addEvent.mock.calls.map((c) => c[1])).not.toContain("sleep");
  });

  it("all-skipped run writes nothing and surfaces the nothing-to-save notice", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("What are you grateful for?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("What's the plan for today?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("Energy");
    await user.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() => expect(messageInfo).toHaveBeenCalled());
    expect(addEvent).not.toHaveBeenCalled();
  });
});
