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
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import dayjs from "dayjs";

// --- Mocks ---------------------------------------------------------------

const mockLifeBackend = {
  getOrCreateLog: vi.fn(),
  addEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  subscribeToEvents: vi.fn(() => () => {}),
  clearSampleSchedule: vi.fn(),
};

const mockUserBackend = {
  getProfile: vi.fn().mockResolvedValue({}),
  updateProfile: vi.fn(),
  saveFcmToken: vi.fn(),
  removeFcmToken: vi.fn(),
  getFcmTokens: vi.fn().mockResolvedValue([]),
  clearAllFcmTokens: vi.fn(),
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
import { LifeProvider } from "../life-context";

// --- Helpers -------------------------------------------------------------

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
          <Route path="/" element={<LifeDashboard embedded />} />
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
    await waitFor(() => {
      // Going forward from yesterday lands on today — the URL holds an
      // explicit ?date=<today> (the nav helper always writes), which is the
      // documented behavior. The "tap date display to clear" affordance is
      // the way back to a clean URL; that's covered in its own test.
      expect(getLocation().search).toBe(`?date=${todayYmd()}`);
    });
    await screen.findByText("Today");
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
