/**
 * Fix B — Settings reachable from every bottom-tab gear. Each of the three
 * bottom-tab screens (Daily, Journal, Coach) must surface the shared
 * "Settings" (+ "Sign Out" when not embedded) menu fragment that
 * LifeRoutesInner provides via SettingsMenuProvider.
 *
 * AppHeader is stubbed to render its `menuItems` as plain buttons so we can
 * assert the labels without driving AntD's Dropdown portal under happy-dom. The
 * assertion is the wiring: the provider's fragment shows up in each route's
 * header menu (and Journal keeps its own "Insights" item too).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App as AntApp } from "antd";

interface MenuItem {
  key?: string;
  label?: ReactNode;
  type?: string;
  onClick?: () => void;
}

// Stub AppHeader to expose menuItems as buttons (key = data-testid).
vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "u1" }, loading: false }),
    useLifeBackend: () => ({ addEvent: vi.fn(), deleteEvent: vi.fn(), updateTrackable: vi.fn() }),
    useWpbDebug: () => ({ snapshot: () => ({ collections: {}, pending: 0 }), events: () => [] }),
    SyncDot: () => null,
    useObserverBackend: () => ({ listObservations: vi.fn().mockResolvedValue([]), getObservation: vi.fn() }),
    getApiBase: () => "http://test",
    getAuthHeaders: () => ({}),
    // Push lives in @kirkl/shared now; stub it inert (no SW / Notification in jsdom).
    isNotificationSupported: vi.fn(() => false),
    initializeMessaging: vi.fn().mockResolvedValue(false),
    reconcilePushSubscription: vi.fn().mockResolvedValue(false),
    requestNotificationPermission: vi.fn().mockResolvedValue(false),
    disableNotifications: vi.fn().mockResolvedValue(undefined),
    onForegroundMessage: vi.fn(() => () => {}),
    listenForServiceWorkerMessages: vi.fn(() => () => {}),
    usePushToggle: () => ({ enabled: false, loading: false, supported: false, toggle: vi.fn().mockResolvedValue(false) }),
    AppHeader: ({ title, menuItems = [] }: { title: ReactNode; menuItems?: MenuItem[] }) => (
      <header>
        <div>{title}</div>
        {(menuItems as MenuItem[])
          .filter((i) => i.type !== "divider")
          .map((i) => (
            <button key={i.key} data-testid={`menu-${i.key}`} onClick={i.onClick}>
              {i.label}
            </button>
          ))}
      </header>
    ),
  };
});

// LifeDashboard reaches into the entries subscription; stub it so the Daily
// surface mounts under happy-dom without PB. (Push is stubbed via @kirkl/shared.)
vi.mock("../subscription", () => ({ useEntriesSubscription: () => {} }));

import { LifeDashboard } from "./LifeDashboard";
import { Coach } from "./Coach";
import { Journal } from "./Journal";
import { LifeProvider } from "../life-context";
import { SettingsMenuProvider } from "../settings-menu";

const openSettings = vi.fn();
const SHARED_FRAGMENT = [
  { key: "settings", label: "Settings", onClick: openSettings },
  { type: "divider" as const },
  { key: "logout", label: "Sign Out", onClick: vi.fn() },
];

function renderRoute(node: ReactNode, at: string) {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={[at]}>
        <LifeProvider>
          <SettingsMenuProvider value={{ menuItems: SHARED_FRAGMENT }}>
            <Routes>
              <Route path={at} element={node} />
            </Routes>
          </SettingsMenuProvider>
        </LifeProvider>
      </MemoryRouter>
    </AntApp>,
  );
}

describe("Settings reachable from every bottom-tab gear", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Daily exposes the shared Settings + Sign Out fragment", async () => {
    renderRoute(<LifeDashboard />, "/");
    expect(await screen.findByTestId("menu-settings")).toHaveTextContent("Settings");
    expect(screen.getByTestId("menu-logout")).toHaveTextContent("Sign Out");
  });

  it("Coach exposes the shared Settings fragment", async () => {
    renderRoute(<Coach />, "/coach");
    expect(await screen.findByTestId("menu-settings")).toHaveTextContent("Settings");
    expect(screen.getByTestId("menu-logout")).toBeInTheDocument();
  });

  it("Journal keeps its Insights item AND appends the shared Settings fragment", async () => {
    renderRoute(<Journal />, "/journal");
    expect(await screen.findByTestId("menu-insights")).toHaveTextContent("Insights");
    expect(screen.getByTestId("menu-settings")).toHaveTextContent("Settings");
    expect(screen.getByTestId("menu-logout")).toHaveTextContent("Sign Out");
  });

  it("the Settings menu item opens settings (fires the provider's opener)", async () => {
    renderRoute(<LifeDashboard />, "/");
    (await screen.findByTestId("menu-settings")).click();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
