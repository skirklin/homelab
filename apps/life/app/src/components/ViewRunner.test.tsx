/**
 * ViewRunner — the Phase-B2 data-driven guided wizard.
 *
 * The CRUX is the PARITY GATE: for representative answer sets across all three
 * default Views (morning / evening / weekly), the ViewRunner's resulting
 * `addEvent` call (subject_id + entries) must be BYTE-IDENTICAL to what the old
 * `answersToEntries` / SessionRunner path produced for the same answers —
 * including the conditional drop of `intention_followup` when there is no
 * morning intention, and the sparse-skip of empty answers.
 *
 * The reference (`answersToEntries` over `SESSIONS`) below is copied VERBATIM
 * from the deleted SessionRunner so the gate compares against the real old
 * behavior, not a paraphrase of it.
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

import { ViewRunner, synthesizeViewEvents } from "./ViewRunner";
import { LifeProvider, useLifeContext } from "../life-context";
import { SESSIONS, type Session } from "../manifest";
import type { LifeLog, LogEvent } from "../types";

// ── The OLD reference (verbatim from the deleted SessionRunner) ──────────────
// Keyed by the legacy prompt id; the exact type/unit/scale the fat event used.
function answersToEntries(session: Session, answers: Record<string, unknown>): LifeEntry[] {
  const out: LifeEntry[] = [];
  for (const prompt of session.prompts) {
    const v = answers[prompt.id];
    if (v === undefined || v === null || v === "") continue;
    if (prompt.type === "text" && typeof v === "string") {
      out.push({ name: prompt.id, type: "text", value: v });
    } else if (prompt.type === "rating" && typeof v === "number") {
      out.push({ name: prompt.id, type: "number", value: v, unit: "rating", scale: prompt.max ?? 5 });
    } else if (prompt.type === "number" && typeof v === "number") {
      out.push({ name: prompt.id, type: "number", value: v, unit: prompt.unit ?? "ct" });
    } else if (prompt.type === "checkbox") {
      out.push({ name: prompt.id, type: "number", value: v ? 1 : 0, unit: "ct" });
    }
  }
  return out;
}

const session = (id: Session["id"]) => SESSIONS.find((s) => s.id === id)!;

const BASE_LOG: LifeLog = {
  id: "log1",
  sampleSchedule: null,
  manifest: { trackables: [] },
  randomSamplingEnabled: false,
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

describe("synthesizeViewEvents — fat-session → new-vocab projection (B2 reality)", () => {
  it("projects a fat morning_session into synthetic daily_intention/gratitude/energy events", () => {
    const fat = makeEvent("morning_session", [
      { name: "gratitude", type: "text", value: "coffee" },
      { name: "intention", type: "text", value: "ship it" },
      { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
    const out = synthesizeViewEvents([fat]);
    const bySubject = (id: string) => out.filter((e) => e.subjectId === id);
    expect(bySubject("daily_intention")[0]?.entries).toEqual([{ name: "intention", type: "text", value: "ship it" }]);
    expect(bySubject("gratitude")[0]?.entries).toEqual([{ name: "gratitude", type: "text", value: "coffee" }]);
    expect(bySubject("energy")).toHaveLength(1);
    // Originals are preserved.
    expect(bySubject("morning_session")).toHaveLength(1);
  });

  it("projects weekly_review_session.intention → weekly_intention (NOT daily)", () => {
    const fat = makeEvent("weekly_review_session", [{ name: "intention", type: "text", value: "rest more" }]);
    const out = synthesizeViewEvents([fat]);
    expect(out.filter((e) => e.subjectId === "weekly_intention")[0]?.entries).toEqual([
      { name: "intention", type: "text", value: "rest more" },
    ]);
    expect(out.filter((e) => e.subjectId === "daily_intention")).toHaveLength(0);
  });

  it("is inert when there are no fat session events", () => {
    const plain = makeEvent("gratitude", [{ name: "note", type: "text", value: "x" }]);
    expect(synthesizeViewEvents([plain])).toEqual([plain]);
  });
});

describe("ViewRunner — templating resolves against REAL fat-session history (B2)", () => {
  it("evening shows intention_followup when today's morning_session has an intention", async () => {
    const events = [makeEvent("morning_session", [{ name: "intention", type: "text", value: "ship it" }])];
    renderView("evening", "/evening", events);
    await screen.findByText("How did the plan hold up?");
    expect(screen.getByText(/This morning's plan: “ship it”/)).toBeInTheDocument();
  });

  it("morning shows the week banner when a recent weekly_review_session has an intention", async () => {
    const events = [makeEvent("weekly_review_session", [{ name: "intention", type: "text", value: "rest more" }])];
    renderView("morning", "/morning", events);
    await screen.findByText("What are you grateful for?");
    expect(screen.getByText(/This week: rest more/)).toBeInTheDocument();
  });
});

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

describe("ViewRunner — byte-identical parity with answersToEntries", () => {
  it("morning: full answer set matches the fat morning_session event", async () => {
    const user = userEvent.setup();
    renderView("morning", "/morning");
    await answerText(user, "What are you grateful for?", "my coffee", false);
    await answerText(user, "What's the plan for today?", "finish B2", false);
    await answerRating(user, "Energy", 4, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    const expected = answersToEntries(session("morning"), {
      gratitude: "my coffee",
      intention: "finish B2",
      energy: 4,
    });
    expect(subjectId).toBe("morning_session");
    expect(entries).toEqual(expected);
    expect(addEvent.mock.calls[0][4]).toEqual({ labels: { source: "manual" } });
  });

  it("morning: sparse run (only energy) matches", async () => {
    const user = userEvent.setup();
    renderView("morning", "/morning");
    await answerText(user, "What are you grateful for?", null, false);
    await answerText(user, "What's the plan for today?", null, false);
    await answerRating(user, "Energy", 2, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    expect(subjectId).toBe("morning_session");
    expect(entries).toEqual(answersToEntries(session("morning"), { energy: 2 }));
  });

  it("evening WITH morning intention: intention_followup + win + lesson matches", async () => {
    const user = userEvent.setup();
    const events = [makeEvent("daily_intention", [{ name: "intention", type: "text", value: "ship it" }])];
    renderView("evening", "/evening", events);
    await answerText(user, "How did the plan hold up?", "held up fine", false);
    await answerText(user, "One thing that went well", "shipped B2", false);
    await answerText(user, "What did today show you?", "tests first", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    // Old path: the contextKey-resolved follow-up renders, so all three prompts.
    const expected = answersToEntries(session("evening"), {
      intention_followup: "held up fine",
      win: "shipped B2",
      lesson: "tests first",
    });
    expect(subjectId).toBe("evening_session");
    expect(entries).toEqual(expected);
  });

  it("evening WITHOUT morning intention: follow-up dropped, win + lesson matches", async () => {
    const user = userEvent.setup();
    renderView("evening", "/evening");
    await answerText(user, "One thing that went well", "a quiet day", false);
    await answerText(user, "What did today show you?", "rest is fine", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    // Old path: the follow-up prompt was filtered out (contextKey === null), so
    // it never contributes an entry even though the prompt exists in SESSIONS.
    const expected = answersToEntries({ ...session("evening"), prompts: session("evening").prompts.filter((p) => p.id !== "intention_followup") }, {
      win: "a quiet day",
      lesson: "rest is fine",
    });
    expect(subjectId).toBe("evening_session");
    expect(entries).toEqual(expected);
    // The follow-up entry name must NOT appear.
    expect((entries as LifeEntry[]).map((e) => e.name)).not.toContain("intention_followup");
  });

  it("weekly: full answer set matches the fat weekly_review_session event", async () => {
    const user = userEvent.setup();
    renderView("weekly", "/weekly");
    await answerText(user, "What's worth remembering from this week?", "shipped a lot", false);
    await answerText(user, "What was hard?", "long days", false);
    await answerText(user, "What did this week teach you?", "pace myself", false);
    await answerText(user, "One intention for the week ahead?", "rest more", true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    const expected = answersToEntries(session("weekly_review"), {
      highlights: "shipped a lot",
      lows: "long days",
      lesson: "pace myself",
      intention: "rest more",
    });
    // The View id is `weekly`, but the fat subject_id MUST stay
    // `weekly_review_session` (the legacy session subject the readers key on) —
    // NOT `weekly_session`. This is the load-bearing LEGACY_SESSION_SUBJECT map.
    expect(subjectId).toBe("weekly_review_session");
    expect(entries).toEqual(expected);
  });

  it("DEFAULT_VIEW_TRACKABLES wins over a colliding-id user row (B2 parity preserved)", async () => {
    // A live user already owns a trackable whose id collides with the reflective
    // `energy` vocab, but at a DIFFERENT shape (`did`, not `rated`). The default
    // view row MUST win, or the energy step would render the `did` text input
    // and buildFatEntries would emit `unit:"min"` instead of the rating entry —
    // silently breaking byte-parity for that user.
    const user = userEvent.setup();
    const userTrackables: LifeManifestTrackable[] = [
      { id: "energy", label: "Energy minutes", shape: "did" },
    ];
    renderView("morning", "/morning", [], userTrackables);
    await answerText(user, "What are you grateful for?", null, false);
    await answerText(user, "What's the plan for today?", null, false);
    // If the user's `did` row had won, this step would be a text Input with no
    // "4" rating button — clicking it would fail.
    await answerRating(user, "Energy", 4, true);

    await waitFor(() => expect(addEvent).toHaveBeenCalledTimes(1));
    const [, subjectId, entries] = addEvent.mock.calls[0];
    expect(subjectId).toBe("morning_session");
    // Byte-identical to the rated default, NOT the `did` (unit:"min") shape.
    expect(entries).toEqual([{ name: "energy", type: "number", value: 4, unit: "rating", scale: 5 }]);
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
