/**
 * The morning wizard's merged-sleep step (contract item 6 of the 2026-06
 * shape redesign):
 *   - duration + optional quality rating + optional notes are written as ONE
 *     merged `sleep` event with canonical did-shape entries
 *   - a `sleep_quality` event is NEVER written
 *   - skipping the step writes no sleep event
 *   - a partial answer (rating without duration) blocks Next; Skip clears it
 *   - a sleep-only run (every other prompt skipped) writes just the sleep
 *     event, never an empty-payload session event
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

/** Step through gratitude/intention/energy, answering only `energy` (4). */
async function finishRemainingPrompts(user: ReturnType<typeof userEvent.setup>) {
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
}

describe("SessionRunner morning sleep step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("writes ONE merged sleep event (duration + rating + notes) and never sleep_quality", async () => {
    const user = userEvent.setup();
    renderMorning();

    // Step 0 is the sleep step.
    await screen.findByText("How did you sleep?");
    // Duration defaults to hours mode: 7.5h → 450 min.
    await user.type(screen.getByRole("spinbutton"), "7.5");
    await user.click(screen.getByRole("button", { name: "Quality 4" }));
    await user.type(screen.getByPlaceholderText("Notes (optional)"), "woke once");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await finishRemainingPrompts(user);
    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));

    const subjects = addEvent.mock.calls.map((c) => c[1]);
    expect(subjects).toContain("sleep");
    expect(subjects).toContain("morning_session");
    expect(subjects).not.toContain("sleep_quality");

    const sleepCall = addEvent.mock.calls.find((c) => c[1] === "sleep")!;
    expect(sleepCall[0]).toBe("log1");
    expect(sleepCall[2]).toEqual([
      { name: "duration", type: "number", value: 450, unit: "min" },
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
      { name: "notes", type: "text", value: "woke once" },
    ]);

    // The session event carries only the session prompts — no sleep entries.
    const sessionCall = addEvent.mock.calls.find((c) => c[1] === "morning_session")!;
    expect(sessionCall[2]).toEqual([
      { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });

  it("duration-only sleep logs just the duration entry", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("How did you sleep?");
    await user.type(screen.getByRole("spinbutton"), "8");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await finishRemainingPrompts(user);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));
    const sleepCall = addEvent.mock.calls.find((c) => c[1] === "sleep")!;
    expect(sleepCall[2]).toEqual([
      { name: "duration", type: "number", value: 480, unit: "min" },
    ]);
  });

  it("skipping the sleep step writes no sleep event", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("How did you sleep?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await finishRemainingPrompts(user);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    expect(addEvent.mock.calls[0][1]).toBe("morning_session");
  });

  it("a partial answer (rating, no duration) blocks Next; Skip clears it and proceeds", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("How did you sleep?");
    await user.click(screen.getByRole("button", { name: "Quality 3" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText("Add a duration to log sleep — or Skip.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip" }));
    await finishRemainingPrompts(user);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    expect(addEvent.mock.calls[0][1]).toBe("morning_session");
  });

  it("sleep-only run writes the sleep event and no empty session event", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("How did you sleep?");
    await user.type(screen.getByRole("spinbutton"), "7");
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Skip gratitude + intention; skip energy via Done? Energy is the last
    // prompt — Skip on the last step submits. Leave it unanswered.
    await screen.findByText("What are you grateful for?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("What's the plan for today?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("Energy");
    await user.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    expect(addEvent.mock.calls[0][1]).toBe("sleep");
    expect(addEvent.mock.calls[0][2]).toEqual([
      { name: "duration", type: "number", value: 420, unit: "min" },
    ]);
    expect(messageInfo).not.toHaveBeenCalled();
  });

  it("all-skipped run writes nothing and surfaces the nothing-to-save notice", async () => {
    const user = userEvent.setup();
    renderMorning();

    await screen.findByText("How did you sleep?");
    await user.click(screen.getByRole("button", { name: "Skip" }));
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
