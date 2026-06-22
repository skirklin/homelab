/**
 * Route-tree integration: the persistent bottom tab bar renders on the primary
 * destinations standalone, is hidden when `embedded` (host shell owns chrome),
 * and is hidden on the full-screen flows (session runners, observation detail).
 *
 * Mocks @kirkl/shared / subscription / messaging like LifeDashboard.test so the
 * tree mounts without a real PocketBase or service worker. getOrCreateLog
 * resolves a log so LifeRoutesInner gets past its loading gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockLog = { id: "log1", ownerId: "user123" };

const mockLifeBackend = {
  getOrCreateLog: vi.fn().mockResolvedValue(mockLog),
  addEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  subscribeToEvents: vi.fn(() => () => {}),
  clearSampleSchedule: vi.fn(),
};

const mockChatBackend = { listMessages: vi.fn().mockResolvedValue([]) };

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "user123" }, loading: false }),
    useLifeBackend: () => mockLifeBackend,
    useChatBackend: () => mockChatBackend,
    useUserBackend: () => ({
      getProfile: vi.fn().mockResolvedValue({}),
      listPushSubscriptions: vi.fn().mockResolvedValue([]),
      subscribeSlugs: vi.fn(() => () => {}),
    }),
    useWpbDebug: () => ({ snapshot: () => ({ collections: {}, pending: 0 }), events: () => [] }),
    SyncDot: () => null,
    AppHeader: ({ title }: { title: ReactNode }) => <header>{title}</header>,
    getBackend: () => ({ authStore: { clear: () => {} } }),
    // Push lives in @kirkl/shared now; stub it inert (no SW / Notification in jsdom).
    isNotificationSupported: vi.fn(() => false),
    initializeMessaging: vi.fn().mockResolvedValue(false),
    reconcilePushSubscription: vi.fn().mockResolvedValue(false),
    requestNotificationPermission: vi.fn().mockResolvedValue(false),
    disableNotifications: vi.fn().mockResolvedValue(undefined),
    onForegroundMessage: vi.fn(() => () => {}),
    listenForServiceWorkerMessages: vi.fn(() => () => {}),
    usePushToggle: () => ({ enabled: false, loading: false, supported: false, toggle: vi.fn().mockResolvedValue(false) }),
  };
});

vi.mock("./subscription", () => ({ useEntriesSubscription: () => {} }));

import { LifeRoutes } from "./module";
import { LifeProvider } from "./life-context";

function renderApp(at: string, embedded = false) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <LifeProvider>
        <LifeRoutes embedded={embedded} />
      </LifeProvider>
    </MemoryRouter>,
  );
}

describe("life route tree — bottom tab bar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the bottom bar on the Daily surface (standalone)", async () => {
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("bottom-tab-bar")).toBeInTheDocument());
    expect(screen.getByTestId("tab-daily")).toBeInTheDocument();
    expect(screen.getByTestId("tab-coach")).toBeInTheDocument();
  });

  it("redirects the legacy /today route to the Daily surface at /", async () => {
    renderApp("/today");
    // The redirect lands on "/", which renders the Daily surface with its bar +
    // Daily tab (the old Today screen no longer exists).
    await waitFor(() => expect(screen.getByTestId("bottom-tab-bar")).toBeInTheDocument());
    expect(screen.getByTestId("tab-daily")).toHaveAttribute("aria-current", "page");
  });

  it("hides the bottom bar when embedded", async () => {
    renderApp("/", true);
    // Wait for the log to load past the spinner, then assert no bar.
    await waitFor(() => expect(screen.getByText("Life")).toBeInTheDocument());
    expect(screen.queryByTestId("bottom-tab-bar")).not.toBeInTheDocument();
  });

  it("hides the bottom bar on a session runner (full-screen flow)", async () => {
    renderApp("/morning");
    // Give the loading gate time to resolve the log.
    await waitFor(() => expect(mockLifeBackend.getOrCreateLog).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("bottom-tab-bar")).not.toBeInTheDocument());
  });
});
