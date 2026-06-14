/**
 * Today (the review lens): renders the Timeline/Habits toggle + the session
 * streak grid, and its date stepping (shared with Log via ?date=) works.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const mockLifeBackend = {
  getOrCreateLog: vi.fn(),
  addEvent: vi.fn(),
  subscribeToEvents: vi.fn(() => () => {}),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "user123" }, loading: false }),
    useLifeBackend: () => mockLifeBackend,
    useWpbDebug: () => ({ snapshot: () => ({ collections: {}, pending: 0 }), events: () => [] }),
    SyncDot: () => null,
    AppHeader: ({ title }: { title: ReactNode }) => <header>{title}</header>,
  };
});

import { Today } from "./Today";
import { LifeProvider } from "../life-context";

function yesterdayYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type LocationSnapshot = { pathname: string; search: string };
function LocationProbe({ onChange }: { onChange: (l: LocationSnapshot) => void }) {
  const loc = useLocation();
  onChange({ pathname: loc.pathname, search: loc.search });
  return null;
}

function renderToday(at = "/today") {
  let current: LocationSnapshot = { pathname: at, search: "" };
  const view = render(
    <MemoryRouter initialEntries={[at]}>
      <LifeProvider>
        <Routes>
          <Route path="/today" element={<Today />} />
        </Routes>
        <LocationProbe onChange={(l) => (current = l)} />
      </LifeProvider>
    </MemoryRouter>,
  );
  return { ...view, getLocation: () => current };
}

describe("Today", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the Timeline/Habits lens toggle", async () => {
    renderToday();
    await waitFor(() => expect(screen.getByTestId("review-lens-toggle")).toBeInTheDocument());
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("Habits")).toBeInTheDocument();
  });

  it("renders the Streaks section", async () => {
    renderToday();
    await screen.findByText("Streaks");
    // Morning/Evening session streak labels.
    expect(screen.getByText("Morning")).toBeInTheDocument();
    expect(screen.getByText("Evening")).toBeInTheDocument();
  });

  it("date stepping: prev-day button writes ?date=<yesterday>", async () => {
    const user = userEvent.setup();
    const { getLocation, container } = renderToday();
    await screen.findByTestId("review-lens-toggle");

    const navButtons = container.querySelectorAll(".ant-btn-text");
    expect(navButtons.length).toBeGreaterThanOrEqual(2);
    await user.click(navButtons[0] as HTMLButtonElement);

    await waitFor(() => {
      expect(getLocation().search).toBe(`?date=${yesterdayYmd()}`);
    });
    await screen.findByText("Yesterday");
  });

  it("Habits toggle swaps the lens", async () => {
    const user = userEvent.setup();
    const { container } = renderToday();
    const toggle = await screen.findByTestId("review-lens-toggle");
    // Scope to the Segmented so we don't collide with any "Habits" text the
    // HabitBoard itself might render.
    const habitsItem = within(toggle).getByText("Habits");
    await user.click(habitsItem);
    await waitFor(() => {
      expect(container.querySelector(".ant-segmented-item-selected")?.textContent).toContain(
        "Habits",
      );
    });
  });
});
