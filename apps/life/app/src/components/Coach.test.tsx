/**
 * Coach hub: the Insights ⇄ Observations segmented mirrors the route. Mounted
 * on /observations (default — the AI feed) and /insights, picks the active view
 * from the path, and the toggle navigates between them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const mockObserver = {
  listObservations: vi.fn().mockResolvedValue([]),
  getObservation: vi.fn(),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "user123" }, loading: false }),
    useObserverBackend: () => mockObserver,
    getApiBase: () => "http://test",
    getAuthHeaders: () => ({}),
  };
});

import { Coach } from "./Coach";
import { LifeProvider } from "../life-context";

type Loc = { pathname: string };
function LocationProbe({ onChange }: { onChange: (l: Loc) => void }) {
  const loc = useLocation();
  onChange({ pathname: loc.pathname });
  return null;
}

function renderCoach(at: string) {
  let current: Loc = { pathname: at };
  const view = render(
    <AntApp>
      <MemoryRouter initialEntries={[at]}>
        <LifeProvider>
          <Routes>
            {/* Coach is mounted on all three routes in the real app. */}
            <Route path="/coach" element={<Coach />} />
            <Route path="/insights" element={<Coach />} />
            <Route path="/observations" element={<Coach />} />
          </Routes>
          <LocationProbe onChange={(l) => (current = l)} />
        </LifeProvider>
      </MemoryRouter>
    </AntApp>,
  );
  return { ...view, getLocation: () => current };
}

describe("Coach", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the Insights/Observations segmented", async () => {
    renderCoach("/observations");
    await screen.findByTestId("coach-toggle");
    expect(screen.getByText("Observations")).toBeInTheDocument();
    expect(screen.getByText("Insights")).toBeInTheDocument();
  });

  it("lands on Observations (the AI feed) on /observations", async () => {
    renderCoach("/observations");
    // The "Ask Claude" affordance is the Observations view's signature element.
    await screen.findByText(/Ask Claude about the last 2 weeks/i);
  });

  it("toggling to Insights navigates to /insights and swaps the view", async () => {
    const user = userEvent.setup();
    const { getLocation } = renderCoach("/observations");
    await screen.findByText(/Ask Claude about the last 2 weeks/i);

    const toggle = await screen.findByTestId("coach-toggle");
    await user.click(toggle.querySelector(".ant-segmented-item-input[value='insights']") as HTMLElement
      ?? screen.getByText("Insights"));

    await waitFor(() => expect(getLocation().pathname).toBe("/insights"));
    // Insights view no longer shows the Observations CTA.
    await waitFor(() =>
      expect(screen.queryByText(/Ask Claude about the last 2 weeks/i)).not.toBeInTheDocument(),
    );
  });

  it("lands on Insights view on /insights", async () => {
    renderCoach("/insights");
    await screen.findByTestId("coach-toggle");
    // No Observations CTA on the Insights view.
    await waitFor(() =>
      expect(screen.queryByText(/Ask Claude about the last 2 weeks/i)).not.toBeInTheDocument(),
    );
  });
});
