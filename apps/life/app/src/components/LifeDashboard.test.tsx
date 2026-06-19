/**
 * Component tests for LifeDashboard's URL-as-source-of-truth date plumbing.
 *
 * Covers the `?date=YYYY-MM-DD` URL sync behavior:
 *   - default URL renders "Today"
 *   - valid past date renders that day
 *   - garbage date scrubs the param and falls back to today
 *   - prev/next buttons update the URL
 *   - tapping the date display on a past day clears the param
 *
 * Mocks @kirkl/shared, ../subscription, and ../messaging so the dashboard
 * mounts without a real PocketBase, service worker, or push subscription.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import dayjs from "dayjs";
import type { LogEvent } from "../types";

// --- Mocks ---------------------------------------------------------------

const mockLifeBackend = {
  getOrCreateLog: vi.fn(),
  addEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  updateTrackable: vi.fn(),
  reorderTrackables: vi.fn(),
  reorderGoals: vi.fn(),
  subscribeToEvents: vi.fn(() => () => {}),
  clearSampleSchedule: vi.fn(),
};

const mockUserBackend = {
  getProfile: vi.fn().mockResolvedValue({}),
  updateProfile: vi.fn(),
  listPushSubscriptions: vi.fn().mockResolvedValue([]),
  clearPushSubscriptions: vi.fn(),
  getNotificationMode: vi.fn().mockResolvedValue("subscribed"),
  setNotificationMode: vi.fn(),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "user123" }, loading: false }),
    useLifeBackend: () => mockLifeBackend,
    useUserBackend: () => mockUserBackend,
    useWpbDebug: () => ({
      snapshot: () => ({ collections: {}, pending: 0 }),
      events: () => [],
    }),
    // Render-only stubs so we don't drag in wpb polling or AppHeader's full
    // dropdown machinery in jsdom.
    SyncDot: () => null,
    AppHeader: ({ title }: { title: ReactNode }) => <header>{title}</header>,
    getBackend: () => ({ authStore: { clear: () => {} } }),
  };
});

// `../subscription` calls life.subscribeToEvents which we no-op above, but
// stub the whole module so the useEffect dep on `life` doesn't churn.
vi.mock("../subscription", () => ({
  useEntriesSubscription: () => {},
}));

// `../messaging` reaches into navigator.serviceWorker / Notification which
// jsdom doesn't have. Replace with inert stubs.
vi.mock("../messaging", () => ({
  initializeMessaging: vi.fn().mockResolvedValue(false),
  requestNotificationPermission: vi.fn().mockResolvedValue(false),
  disableNotifications: vi.fn().mockResolvedValue(undefined),
  onForegroundMessage: vi.fn(() => () => {}),
  listenForServiceWorkerMessages: vi.fn(() => () => {}),
  getNotificationPermissionStatus: vi.fn(() => "unsupported"),
}));

// --- Imports under test (after mocks) ------------------------------------

import { LifeDashboard } from "./LifeDashboard";
import { LifeProvider, useLifeContext } from "../life-context";

// --- Helpers -------------------------------------------------------------

function yesterdayYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Pick a date roughly two weeks in the past so it never collides with
 * "Today"/"Yesterday" no matter when the suite runs. Returns both the YMD
 * string for the URL and the rendered "ddd, MMM D" label that
 * `formatDateLabel()` produces.
 */
function pastDate(): { ymd: string; label: string } {
  const d = new Date();
  d.setDate(d.getDate() - 14);
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { ymd: `${y}-${m}-${day}`, label: dayjs(d).format("ddd, MMM D") };
}

/**
 * The "ddd, MMM D" label `formatDateLabel()` renders for N days before today.
 * N must be >= 2 so the label is never "Today"/"Yesterday".
 */
function daysAgoLabel(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return dayjs(d).format("ddd, MMM D");
}

/** Captures location changes inside the MemoryRouter so tests can assert
 *  the URL after a click without poking window.location. */
type LocationSnapshot = { pathname: string; search: string };
function LocationProbe({ onChange }: { onChange: (loc: LocationSnapshot) => void }) {
  const loc = useLocation();
  onChange({ pathname: loc.pathname, search: loc.search });
  return null;
}

function renderDashboard(initialEntry: string) {
  let current: LocationSnapshot = { pathname: "/", search: "" };
  const probe = (loc: LocationSnapshot) => {
    current = loc;
  };
  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LifeProvider>
        <Routes>
          <Route path="/" element={<LifeDashboard />} />
        </Routes>
        <LocationProbe onChange={probe} />
      </LifeProvider>
    </MemoryRouter>,
  );
  return { ...view, getLocation: () => current };
}

// --- Session-card seeding ------------------------------------------------

type SessionView = "morning" | "evening" | "weekly";

/**
 * Build a per-item morning/evening/weekly run the way the ViewRunner writes
 * it post-B3.3: N separate `life_events` rows, one per captured vocab id, each
 * carrying `labels.view` + a shared `labels.view_run`. There is NO fat
 * `<view>_session` event — the old "logged today?" scan looked for exactly
 * that subject_id and is why the live dashboard showed "missed earlier?" after
 * the fanout migration.
 */
function perItemRun(
  view: SessionView,
  vocabIds: string[],
  when: Date,
): LogEvent[] {
  const viewRun = when.toISOString();
  return vocabIds.map((vocabId) => ({
    id: `${view}-${vocabId}-${when.getTime()}`,
    log: "log1",
    subjectId: vocabId,
    timestamp: when,
    entries: [{ name: "note", type: "text", value: `seed ${vocabId}` }],
    labels: { view, view_run: viewRun },
    createdBy: "user123",
    created: when.toISOString(),
    updated: when.toISOString(),
  })) satisfies LogEvent[];
}

/** Dispatches seed events into the LifeContext on mount, before assertions. */
function SeedEntries({ events }: { events: LogEvent[] }) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    dispatch({ type: "SET_ENTRIES", entries: events });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** Seeds a log with an explicit (possibly empty) `manifest.views` on mount. */
function SeedLog({ views }: { views: { id: string; title: string; items: [] }[] }) {
  const { dispatch } = useLifeContext();
  useEffect(() => {
    dispatch({
      type: "SET_LOG",
      log: {
        id: "log1",
        sampleSchedule: null,
        manifest: { trackables: [], views },
        randomSamplingEnabled: false,
        coachEnabled: true,
        created: "",
        updated: "",
      } as never,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderDashboardWithEntries(events: LogEvent[], initialEntry = "/") {
  let current: LocationSnapshot = { pathname: "/", search: "" };
  const probe = (loc: LocationSnapshot) => {
    current = loc;
  };
  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LifeProvider>
        <SeedEntries events={events} />
        <Routes>
          <Route path="/" element={<LifeDashboard />} />
        </Routes>
        <LocationProbe onChange={probe} />
      </LifeProvider>
    </MemoryRouter>,
  );
  return { ...view, getLocation: () => current };
}

// --- Tests ---------------------------------------------------------------

describe("LifeDashboard URL date plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("default URL (/) renders Today", async () => {
    const { getLocation } = renderDashboard("/");
    await screen.findByText("Today");
    // No date param written on the default path.
    expect(getLocation().search).toBe("");
  });

  it("?date=<valid past date> renders that date label", async () => {
    const { ymd, label } = pastDate();
    renderDashboard(`/?date=${ymd}`);
    await screen.findByText(label);
    // "Today" must NOT be rendered as the date display when a past date is set.
    // (There may be other "Today" text in toolbars; the DateDisplay button is
    // the only one we care about — it's checked by-label above.)
  });

  it("invalid ?date scrubs the param and falls back to Today", async () => {
    const { getLocation } = renderDashboard("/?date=not-a-date");
    await screen.findByText("Today");
    // The scrub effect runs once on mount; assert the bad param is gone.
    await waitFor(() => {
      expect(getLocation().search).toBe("");
    });
  });

  it("prev-day button writes ?date=<yesterday> to the URL", async () => {
    const user = userEvent.setup();
    const { getLocation, container } = renderDashboard("/");
    await screen.findByText("Today");

    // The DateNav row has two NavButton (text-type) buttons flanking the
    // DateDisplay. The first one is "prev".
    const navButtons = container.querySelectorAll(".ant-btn-text");
    expect(navButtons.length).toBeGreaterThanOrEqual(2);
    const prevBtn = navButtons[0] as HTMLButtonElement;

    await user.click(prevBtn);

    await waitFor(() => {
      expect(getLocation().search).toBe(`?date=${yesterdayYmd()}`);
    });
    // Label flips to "Yesterday".
    await screen.findByText("Yesterday");
  });

  it("prev then next returns to default URL and Today", async () => {
    const user = userEvent.setup();
    const { getLocation, container } = renderDashboard("/");
    await screen.findByText("Today");

    const navButtons = container.querySelectorAll(".ant-btn-text");
    const prevBtn = navButtons[0] as HTMLButtonElement;
    const nextBtn = navButtons[1] as HTMLButtonElement;

    await user.click(prevBtn);
    await waitFor(() => {
      expect(getLocation().search).toBe(`?date=${yesterdayYmd()}`);
    });

    await user.click(nextBtn);
    await screen.findByText("Today");
    await waitFor(() => {
      // Going forward from yesterday lands on today. selectedDate === today
      // serializes to null, so the debounced mirror clears the param back to a
      // clean URL on its own — no separate "tap to clear" needed.
      expect(getLocation().search).toBe("");
    });
  });

  it("tapping the date display on a past day clears the URL", async () => {
    const user = userEvent.setup();
    const { ymd, label } = pastDate();
    const { getLocation } = renderDashboard(`/?date=${ymd}`);

    const dateDisplay = await screen.findByText(label);
    await user.click(dateDisplay);

    await waitFor(() => {
      expect(getLocation().search).toBe("");
    });
    await screen.findByText("Today");
  });

  it("rapid prev clicks step the displayed day monotonically with no flicker", async () => {
    // Regression: the viewed day used to be derived from ?date= and read back
    // asynchronously, so each prev step decremented a STALE selectedDate (the
    // previous step's URL write hadn't round-tripped yet). Three taps fired
    // before any commit settled would all decrement from "today" and land on
    // -1, not -3 — the day "jumped around" before settling. selectedDate is now
    // local state, so each handler decrements the latest committed value.
    //
    // We fire three clicks BACK-TO-BACK inside one act() — no awaited settling
    // between them — which is the exact ordering that exposed the stale-closure
    // race. With the old URL-derived code this lands on Yesterday; the fix
    // lands on -3.
    const { container } = renderDashboard("/");
    await screen.findByText("Today");

    const navButtons = container.querySelectorAll(".ant-btn-text");
    const prevBtn = navButtons[0] as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(prevBtn);
      fireEvent.click(prevBtn);
      fireEvent.click(prevBtn);
    });

    // Settled exactly three days back — never bounced toward today, and the
    // stale-closure decrement didn't strand us at -1.
    await screen.findByText(daysAgoLabel(3));
    expect(screen.queryByText(daysAgoLabel(2))).not.toBeInTheDocument();
    expect(screen.queryByText("Yesterday")).not.toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("rapid stepping coalesces to a single ?date= for the final day", async () => {
    // The URL is a lagging, debounced mirror: N rapid steps must not leave N
    // intermediate ?date= values flashing — only the settled day is written.
    const user = userEvent.setup();
    const { getLocation, container } = renderDashboard("/");
    await screen.findByText("Today");

    const navButtons = container.querySelectorAll(".ant-btn-text");
    const prevBtn = navButtons[0] as HTMLButtonElement;

    await user.click(prevBtn);
    await user.click(prevBtn);
    await user.click(prevBtn);

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const y = threeDaysAgo.getFullYear();
    const m = String(threeDaysAgo.getMonth() + 1).padStart(2, "0");
    const day = String(threeDaysAgo.getDate()).padStart(2, "0");
    const ymd = `${y}-${m}-${day}`;

    await waitFor(() => {
      expect(getLocation().search).toBe(`?date=${ymd}`);
    });
  });

  it("next-day button is disabled on Today", async () => {
    const { container } = renderDashboard("/");
    await screen.findByText("Today");

    // Allow effects to settle.
    await act(async () => {
      await Promise.resolve();
    });

    const navButtons = container.querySelectorAll(".ant-btn-text");
    const nextBtn = navButtons[1] as HTMLButtonElement;
    expect(nextBtn).toBeDisabled();
  });
});

describe("LifeDashboard (unified Daily surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Favorites row, the habit board, and the + Log entry point", async () => {
    renderDashboard("/");
    await screen.findByText("Favorites");
    // No favorites by default → quiet hint, not an empty bar.
    expect(screen.getByTestId("favorites-empty")).toBeInTheDocument();
    expect(screen.getByTestId("habit-board")).toBeInTheDocument();
    expect(screen.getByTestId("log-more-shapes")).toBeInTheDocument();
  });

  it("shows the four shape entry points directly (no expand click) and tapping one opens the ShapeSheet", async () => {
    const user = userEvent.setup();
    renderDashboard("/");
    // Always visible — no toggle to expand.
    expect(await screen.findByTestId("log-more-shapes")).toBeInTheDocument();
    for (const shape of ["took", "did", "happened", "rated"]) {
      expect(screen.getByTestId(`log-shape-${shape}`)).toBeInTheDocument();
    }
    // Tapping a shape button opens the ShapeSheet.
    await user.click(screen.getByTestId("log-shape-took"));
    expect(await screen.findByTestId("shape-sheet-search")).toBeInTheDocument();
  });

  it("keeps the Sessions session-View cards when the log has them", async () => {
    renderDashboard("/");
    await screen.findByText("Sessions");
  });

  it("hides the Sessions header entirely when the log has no views (Angela)", async () => {
    // manifest.views = [] resolves to NO views (not the DEFAULT_VIEWS fallback),
    // so the Sessions section header must not render — no orphaned heading.
    render(
      <MemoryRouter initialEntries={["/"]}>
        <LifeProvider>
          <SeedLog views={[]} />
          <Routes>
            <Route path="/" element={<LifeDashboard />} />
          </Routes>
        </LifeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Favorites");
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
  });

  it("no longer renders the Timeline/Habits lens toggle (the board is the only review surface)", async () => {
    renderDashboard("/");
    await screen.findByText("Favorites");
    expect(screen.queryByTestId("review-lens-toggle")).not.toBeInTheDocument();
  });

  it("no longer renders the 2×2 ShapeCard grid", async () => {
    renderDashboard("/");
    await screen.findByText("Favorites");
    for (const shape of ["took", "did", "happened", "rated"]) {
      expect(screen.queryByTestId(`shape-card-${shape}`)).not.toBeInTheDocument();
    }
  });

  it("has no nav affordance pointing at /chat", async () => {
    const { container } = renderDashboard("/");
    await screen.findByText("Favorites");
    // No Chat button/link, and the unread badge is gone.
    expect(screen.queryByText(/^Chat/)).not.toBeInTheDocument();
    expect(container.querySelector("[href='/chat']")).toBeNull();
  });
});

describe("LifeDashboard session cards — logged-today detection (B3.3 repoint)", () => {
  // Pin the clock so session-card prominence + the not-logged prompt are
  // deterministic regardless of when the suite runs. 14:00 local is afternoon:
  // morning is past (so a missing morning run reads "missed earlier?"), and the
  // logged chip still renders whenever a run exists.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const noon = new Date();
    noon.setHours(14, 30, 0, 0);
    vi.setSystemTime(noon);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A representative "today, this afternoon" instant for run timestamps. */
  function todayAt(h: number, m: number): Date {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  it("detects a logged morning from PER-ITEM events (no fat morning_session)", async () => {
    // The regression: post-fanout, morning is stored as separate `gratitude` /
    // `energy` events tagged labels.view="morning". The OLD dashboard scanned
    // for subject_id === "morning_session" (now nonexistent) and so always
    // showed "missed earlier?". The new normalizer path detects the run.
    const when = todayAt(7, 45);
    const events = perItemRun("morning", ["gratitude", "energy"], when);

    renderDashboardWithEntries(events);
    await screen.findByText("Sessions");

    // The morning card shows the LOGGED affordance at the run's time, NOT the
    // missed prompt. With the old `<id>_session` scan this assertion fails.
    await screen.findByText(/logged at 7:45am/i);
    expect(screen.queryByText("missed earlier?")).not.toBeInTheDocument();
  });

  it("shows the capture prompt when there is no morning run today", async () => {
    // No seeded events at all — afternoon with no morning run reads "missed
    // earlier?" and never the logged chip.
    renderDashboardWithEntries([]);
    await screen.findByText("Sessions");

    await screen.findByText("missed earlier?");
    expect(screen.queryByText(/logged at/i)).not.toBeInTheDocument();
  });

  it("a per-item run dated YESTERDAY does not count as logged today", async () => {
    // Run-vs-today bucketing is by user-tz day key. A run from yesterday must
    // not satisfy the morning card — otherwise "logged" would stick forever.
    const yesterday = todayAt(7, 45);
    yesterday.setDate(yesterday.getDate() - 1);
    const events = perItemRun("morning", ["gratitude", "energy"], yesterday);

    renderDashboardWithEntries(events);
    await screen.findByText("Sessions");

    await screen.findByText("missed earlier?");
    expect(screen.queryByText(/logged at/i)).not.toBeInTheDocument();
  });

  it("the morning card navigates to the `morning` route", async () => {
    const { getLocation } = renderDashboardWithEntries([]);
    const card = await screen.findByText("Morning");

    fireEvent.click(card);

    await waitFor(() => {
      expect(getLocation().pathname).toBe("/morning");
    });
  });

  it("the weekly card navigates to `weekly` (not the legacy `weekly_review`)", async () => {
    const { getLocation } = renderDashboardWithEntries([]);
    const card = await screen.findByText("Weekly review");

    fireEvent.click(card);

    await waitFor(() => {
      expect(getLocation().pathname).toBe("/weekly");
    });
  });
});

describe("LifeDashboard session-history drill-down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Sessions header exposes a history affordance that opens the grid drawer", async () => {
    const user = userEvent.setup();
    renderDashboard("/");
    await screen.findByText("Sessions");

    // The drawer is closed initially — neither the drawer chrome nor the grid
    // legend is in the DOM (destroyOnClose).
    expect(screen.queryByTestId("session-history")).not.toBeInTheDocument();

    const openBtn = await screen.findByTestId("session-history-open");
    await user.click(openBtn);

    // Drawer opens and renders the SessionStreakGrid (its legend labels the
    // three split-cell tracks).
    expect(await screen.findByTestId("session-history")).toBeInTheDocument();
    const drawer = screen.getByTestId("session-history");
    expect(within(drawer).getByText("morning")).toBeInTheDocument();
    expect(within(drawer).getByText("evening")).toBeInTheDocument();
    expect(within(drawer).getByText("weekly")).toBeInTheDocument();
  });

  it("no session-history affordance when the log has no views (Angela)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <LifeProvider>
          <SeedLog views={[]} />
          <Routes>
            <Route path="/" element={<LifeDashboard />} />
          </Routes>
        </LifeProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Favorites");
    // The whole Sessions block is gated on sessionViews.length > 0, so the
    // history affordance must be absent too — Angela sees nothing.
    expect(screen.queryByTestId("session-history-open")).not.toBeInTheDocument();
  });
});
