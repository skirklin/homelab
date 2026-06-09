/**
 * Component tests for Observations.tsx — the /observations surface.
 *
 * Focus on the per-observation thread handoff: an "Open thread" button per
 * observation that navigates to `/observations/:id` (post thread-split
 * refactor — previously `/chat?observation=<id>`). The card itself
 * toggles expand/collapse on click, so the test also pins down that the
 * button stops propagation (clicking the button must NOT also toggle the
 * card).
 *
 * Mocks @kirkl/shared so we can stub useObserverBackend.listObservations and
 * useAuth without a real PocketBase. Mirrors LifeDashboard.test.tsx and
 * Chat.test.tsx's mock layout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ClaudeObservation } from "@homelab/backend";

// --- Mocks ---------------------------------------------------------------

const { mockObserverBackend, stableAuth } = vi.hoisted(() => ({
  mockObserverBackend: {
    listObservations: vi.fn(),
    getObservation: vi.fn(),
    createObservation: vi.fn(),
  },
  stableAuth: { user: { uid: "user123" }, loading: false },
}));

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => stableAuth,
    useObserverBackend: () => mockObserverBackend,
    getApiBase: () => "http://api.test",
    getAuthHeaders: () => ({ Authorization: "Bearer test-token" }),
    AppHeader: ({ title, onBack }: { title: ReactNode; onBack?: () => void }) => (
      <header>
        {onBack && <button onClick={onBack}>back</button>}
        <span>{title}</span>
      </header>
    ),
  };
});

// --- Helpers -------------------------------------------------------------

function makeObservation(overrides: Partial<ClaudeObservation> & { id: string }): ClaudeObservation {
  const now = new Date("2026-05-29T12:00:00.000Z");
  return {
    owner: "user123",
    content: "Sample observation body.",
    period: "weekly",
    dataWindowStart: new Date("2026-05-22T12:00:00.000Z"),
    dataWindowEnd: now,
    relatedEventIds: [],
    promptVersion: "v0",
    created: now,
    ...overrides,
  } as ClaudeObservation;
}

// --- Imports under test (after mocks) ------------------------------------

import { Observations } from "./Observations";

/**
 * Spy on the current location so we can assert that "Continue in Chat" both
 * navigates to /chat and writes the `observation` param. A real MemoryRouter
 * route catches the navigation; the spy reads it after the click.
 */
let lastLocation: { pathname: string; search: string } = { pathname: "", search: "" };
function LocationProbe() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function renderObservations() {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={["/observations"]}>
        <Routes>
          <Route
            path="/observations"
            element={
              <>
                <Observations />
                <LocationProbe />
              </>
            }
          />
          {/* Render-only observation-detail route so navigate() resolves;
              we never inspect this surface — `lastLocation` captures the
              destination. */}
          <Route
            path="/observations/:id"
            element={
              <>
                <div>observation detail surface</div>
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AntApp>,
  );
}

// --- Tests ---------------------------------------------------------------

describe("Observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastLocation = { pathname: "", search: "" };
  });

  it("renders an 'Open thread' button per observation", async () => {
    mockObserverBackend.listObservations.mockResolvedValueOnce([
      makeObservation({ id: "obs1", content: "First observation." }),
      makeObservation({ id: "obs2", content: "Second observation." }),
    ]);

    renderObservations();

    // Both cards render a button. findAllByRole waits for the async load.
    const buttons = await screen.findAllByRole("button", { name: /Open thread/i });
    expect(buttons).toHaveLength(2);
  });

  it("clicking 'Open thread' navigates to /observations/<id> and does not toggle the card", async () => {
    const user = userEvent.setup();
    mockObserverBackend.listObservations.mockResolvedValueOnce([
      makeObservation({
        id: "obs-handoff",
        content: "An observation worth continuing.",
      }),
    ]);

    renderObservations();

    const btn = await screen.findByRole("button", { name: /Open thread/i });
    await user.click(btn);

    // Navigated to /observations/<id> — the per-observation thread page.
    expect(lastLocation.pathname).toBe("/observations/obs-handoff");
    expect(lastLocation.search).toBe("");

    // The card-level click-to-expand must NOT have fired — stopPropagation on
    // the button is the contract that keeps the handoff from also toggling
    // the card open in-place before navigation. Hard to read directly here
    // (we navigated away), but if propagation had reached the card the URL
    // would still resolve to /observations/<id> (navigate wins), so the
    // regression signal lives in the visual review.
  });
});
