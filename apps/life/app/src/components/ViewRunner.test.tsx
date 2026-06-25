/**
 * ViewRunner — the data-driven guided wizard (B3.2 per-item write).
 *
 * The CRUX is the WRITE SHAPE: a completed run writes N PER-ITEM events — one
 * per captured, non-empty step — each under its OWN vocab `subject_id`, with
 * canonical shape entries (`note` for noted, `rating` for rated), correlated by
 * a single shared `labels.view` + `labels.view_run`. This replaces B2's
 * byte-identical fat `*_session` write. Behavior preserved: the conditional drop
 * of `intention_followup` when there is no morning intention, the sparse-skip of
 * empty answers, and the templating reads — which resolve against the real
 * per-item events (`daily_intention` / `weekly_intention`) in `state.entries`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useEffect, type ReactNode } from "react";
import type { LifeEntry, LifeEvent, LifeManifestTrackable } from "@homelab/backend";

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

// TasksDueBlock fetches upkeep tasks over the backend — irrelevant to the input
// logic; stub it to a sentinel so its presence is still assertable.
vi.mock("./TasksDueBlock", () => ({
  TasksDueBlock: () => <div data-testid="tasks-due-block" />,
}));

import { ViewRunner } from "./ViewRunner";
import { LifeProvider, useLifeContext } from "../life-context";
import type { LifeLog, LogEvent } from "../types";

/**
 * The N per-item `addEvent(logId, subjectId, entries, uid, opts)` calls reduced
 * to `{ subjectId → entries }` plus the shared run labels — so a per-item write
 * is asserted against expected vocab ids + canonical entries, independent of
 * call order.
 */
function capturedRun() {
  const bySubject: Record<string, LifeEntry[]> = {};
  let labels: Record<string, string> | undefined;
  let timestamp: Date | undefined;
  for (const call of addEvent.mock.calls) {
    const [, subjectId, entries, , opts] = call;
    bySubject[subjectId] = entries;
    labels = opts?.labels;
    timestamp = opts?.timestamp;
  }
  return { bySubject, labels, timestamp };
}

const BASE_LOG: LifeLog = {
  id: "log1",
  sampleSchedule: null,
  manifest: { trackables: [] },
  randomSamplingEnabled: false,
  coachEnabled: true,
  journalEnabled: true,
  created: "2026-06-01T00:00:00Z",
  updated: "2026-06-01T00:00:00Z",
};

function makeEvent(subjectId: string, entries: LifeEntry[]): LifeEvent {
  const now = new Date();
  return {
    id: `${subjectId}-seed`,
    log: "log1",
    subjectId,
    timestamp: now,
    entries,
    createdBy: "u1",
    created: now.toISOString(),
    updated: now.toISOString(),
  };
}

function Seed({
  events,
  trackables,
  children,
}: {
  events: LogEvent[];
  trackables?: LifeManifestTrackable[];
  children: ReactNode;
}) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    const log = trackables ? { ...BASE_LOG, manifest: { trackables } } : BASE_LOG;
    dispatch({ type: "SET_LOG", log });
    if (events.length > 0) dispatch({ type: "SET_ENTRIES", entries: events });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderView(
  viewId: string,
  route: string,
  events: LogEvent[] = [],
  trackables?: LifeManifestTrackable[],
) {
  return render(
    <LifeProvider>
      <Seed events={events} trackables={trackables}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/" element={<div data-testid="dashboard" />} />
            <Route path={route.split("?")[0]} element={<ViewRunner viewId={viewId} />} />
          </Routes>
        </MemoryRouter>
      </Seed>
    </LifeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

// ── Step drivers ────────────────────────────────────────────────────────────
// Type text into the current step's textarea, or click a rating button, then
// advance with Next/Done. `null` answer = Skip.
async function answerText(user: ReturnType<typeof userEvent.setup>, label: string, text: string | null, last: boolean) {
  await screen.findByText(label);
  if (text === null) {
    await user.click(screen.getByRole("button", { name: "Skip" }));
    return;
  }
  const textarea = screen.getByRole("textbox");
  await user.type(textarea, text);
  await user.click(screen.getByRole("button", { name: last ? /Done/ : /Next/ }));
}

async function answerRating(user: ReturnType<typeof userEvent.setup>, label: string, n: number | null, last: boolean) {
  await screen.findByText(label);
  if (n === null) {
    await user.click(screen.getByRole("button", { name: "Skip" }));
    return;
  }
  await user.click(screen.getByRole("button", { name: String(n) }));
  await user.click(screen.getByRole("button", { name: last ? /Done/ : /Next/ }));
}

describe("ViewRunner — step rendering", () => {
  it("renders the morning greeting, the tasks_due block, and the first prompt", async () => {
    renderView("morning", "/morning");
    await screen.findByText("What are you grateful for?");
    expect(screen.getByTestId("tasks-due-block")).toBeInTheDocument();
    expect(screen.getByText(/Good morning/)).toBeInTheDocument();
  });

  it("shows the week-intention banner when a recent weekly_intention exists", async () => {
    const events = [makeEvent("weekly_intention", [{ name: "intention", type: "text", value: "rest more" }])];
    renderView("morning", "/morning", events);
    await screen.findByText("What are you grateful for?");
    expect(screen.getByText(/This week: rest more/)).toBeInTheDocument();
  });

  it("drops the week banner when there is no weekly_intention (no nudge)", async () => {
    renderView("morning", "/morning");
    await screen.findByText("What are you grateful for?");
    expect(screen.queryByText(/This week:/)).not.toBeInTheDocument();
  });

  it("evening shows the intention_followup step (with morning intention substituted) when a daily_intention exists today", async () => {
    const events = [makeEvent("daily_intention", [{ name: "intention", type: "text", value: "ship it" }])];
    renderView("evening", "/evening", events);
    await screen.findByText("How did the plan hold up?");
    expect(screen.getByText(/This morning's plan: “ship it”/)).toBeInTheDocument();
  });

  it("evening DROPS the intention_followup step when there is no daily_intention today", async () => {
    renderView("evening", "/evening");
    // First prompt is the win, not the follow-up.
    await screen.findByText("One thing that went well");
    expect(screen.queryByText("How did the plan hold up?")).not.toBeInTheDocument();
  });
});

describe("ViewRunner — per-item write (B3.2 cutover)", () => {
  it("morning: full run writes 3 per-item events under their vocab ids with shared run labels", async () => {
    const user = userEvent.setup();
    renderView("morning", "/morning");
    await answerText(user, "What are you grateful for?", "my coffee", false);
    await answerText(user, "What's the plan for today?", "finish B3", false);
    await answerRating(user, "Energy", 4, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(3));
    const { bySubject, labels, timestamp } = capturedRun();
    // One event per captured vocab id — NOT a fat `morning_session`.
    expect(Object.keys(bySubject).sort()).toEqual(["daily_intention", "energy", "gratitude"]);
    // Canonical shape entries: noted → {name:"note"}, rated → {name:"rating"}.
    expect(bySubject.gratitude).toEqual([{ name: "note", type: "text", value: "my coffee" }]);
    expect(bySubject.daily_intention).toEqual([{ name: "note", type: "text", value: "finish B3" }]);
    expect(bySubject.energy).toEqual([{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]);
    // Shared run correlation labels + a single run timestamp across all N events.
    expect(labels?.source).toBe("manual");
    expect(labels?.view).toBe("morning");
    expect(labels?.view_run).toBe(timestamp?.toISOString());
    // Every call shared the SAME view_run + timestamp.
    const runs = new Set(addEvent.mock.calls.map((c) => c[4]?.labels?.view_run));
    expect(runs.size).toBe(1);
  });

  it("morning: sparse run (only energy) writes ONE event", async () => {
    const user = userEvent.setup();
    renderView("morning", "/morning");
    await answerText(user, "What are you grateful for?", null, false);
    await answerText(user, "What's the plan for today?", null, false);
    await answerRating(user, "Energy", 2, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const { bySubject } = capturedRun();
    expect(Object.keys(bySubject)).toEqual(["energy"]);
    expect(bySubject.energy).toEqual([{ name: "rating", type: "number", value: 2, unit: "rating", scale: 5 }]);
  });

  it("evening WITH morning intention: writes intention_followup + daily_win + daily_lesson", async () => {
    const user = userEvent.setup();
    const events = [makeEvent("daily_intention", [{ name: "intention", type: "text", value: "ship it" }])];
    renderView("evening", "/evening", events);
    await answerText(user, "How did the plan hold up?", "held up fine", false);
    await answerText(user, "One thing that went well", "shipped B3", false);
    await answerText(user, "What did today show you?", "tests first", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(3));
    const { bySubject, labels } = capturedRun();
    expect(Object.keys(bySubject).sort()).toEqual(["daily_lesson", "daily_win", "intention_followup"]);
    expect(bySubject.intention_followup).toEqual([{ name: "note", type: "text", value: "held up fine" }]);
    expect(bySubject.daily_win).toEqual([{ name: "note", type: "text", value: "shipped B3" }]);
    expect(bySubject.daily_lesson).toEqual([{ name: "note", type: "text", value: "tests first" }]);
    expect(labels?.view).toBe("evening");
  });

  it("evening WITHOUT morning intention: follow-up dropped, writes only daily_win + daily_lesson", async () => {
    const user = userEvent.setup();
    renderView("evening", "/evening");
    await answerText(user, "One thing that went well", "a quiet day", false);
    await answerText(user, "What did today show you?", "rest is fine", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(2));
    const { bySubject } = capturedRun();
    // The follow-up step was never shown (contextKey drop), so no event for it.
    expect(Object.keys(bySubject).sort()).toEqual(["daily_lesson", "daily_win"]);
    expect(bySubject.intention_followup).toBeUndefined();
  });

  it("weekly: full run writes 4 per-item events; view label is `weekly`", async () => {
    const user = userEvent.setup();
    renderView("weekly", "/weekly");
    await answerText(user, "What's worth remembering from this week?", "shipped a lot", false);
    await answerText(user, "What was hard?", "long days", false);
    await answerText(user, "What did this week teach you?", "pace myself", false);
    await answerText(user, "One intention for the week ahead?", "rest more", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(4));
    const { bySubject, labels } = capturedRun();
    expect(Object.keys(bySubject).sort()).toEqual([
      "highlights",
      "lows",
      "weekly_intention",
      "weekly_lesson",
    ]);
    expect(bySubject.weekly_intention).toEqual([{ name: "note", type: "text", value: "rest more" }]);
    // weekly's view label is `weekly` (stable across the cutover), distinct from
    // the historical `weekly_review_session` subject — no fat subject is written.
    expect(labels?.view).toBe("weekly");
  });

  it("DEFAULT_VIEW_TRACKABLES wins over a colliding-id user row (energy stays rated)", async () => {
    // A live user already owns a trackable whose id collides with the reflective
    // `energy` vocab, but at a DIFFERENT shape (`did`, not `rated`). The default
    // view row MUST win, or the energy step would render the `did` text input
    // and emit a duration event instead of the rating.
    const user = userEvent.setup();
    const userTrackables: LifeManifestTrackable[] = [
      { id: "energy", label: "Energy minutes", shape: "did" },
    ];
    renderView("morning", "/morning", [], userTrackables);
    await answerText(user, "What are you grateful for?", null, false);
    await answerText(user, "What's the plan for today?", null, false);
    await answerRating(user, "Energy", 4, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const { bySubject } = capturedRun();
    // Rated entry, NOT a `did` (unit:"min") event.
    expect(bySubject.energy).toEqual([{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]);
  });

  it("all-skipped run writes nothing and surfaces the nothing-to-save notice", async () => {
    const user = userEvent.setup();
    renderView("morning", "/morning");
    await answerText(user, "What are you grateful for?", null, false);
    await answerText(user, "What's the plan for today?", null, false);
    await answerRating(user, "Energy", null, true);

    await waitFor(() => expect(messageInfo).toHaveBeenCalled());
    expect(addEvent).not.toHaveBeenCalled();
  });
});
