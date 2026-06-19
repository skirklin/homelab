/**
 * Bottom tab bar: renders the 4 primary destinations, derives the active tab
 * from the current route (including Coach sub-routes like /insights and
 * /observations/:id), and knows when to hide on full-screen flows.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BottomTabBar, activeTabForPath, showsBottomBar } from "./BottomTabBar";
import * as lifeContext from "../life-context";

function renderBar(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <BottomTabBar />
    </MemoryRouter>,
  );
}

/** Stub the life context's `state.log.coachEnabled` for one render. */
function mockCoach(coachEnabled: boolean | undefined) {
  vi.spyOn(lifeContext, "useLifeContext").mockReturnValue({
    state: {
      log: coachEnabled === undefined ? null : ({ coachEnabled } as never),
      entries: new Map(),
      loading: false,
    },
    dispatch: vi.fn(),
  });
}

describe("BottomTabBar", () => {
  it("renders the 4 primary tabs", () => {
    renderBar("/");
    expect(screen.getByTestId("tab-log")).toBeInTheDocument();
    expect(screen.getByTestId("tab-today")).toBeInTheDocument();
    expect(screen.getByTestId("tab-journal")).toBeInTheDocument();
    expect(screen.getByTestId("tab-coach")).toBeInTheDocument();
    expect(screen.getByText("Log")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Journal")).toBeInTheDocument();
    expect(screen.getByText("Coach")).toBeInTheDocument();
  });

  it("highlights Log on /", () => {
    renderBar("/");
    expect(screen.getByTestId("tab-log")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("tab-coach")).not.toHaveAttribute("aria-current");
  });

  it("highlights Today on /today", () => {
    renderBar("/today");
    expect(screen.getByTestId("tab-today")).toHaveAttribute("aria-current", "page");
  });

  it("highlights Coach on /insights", () => {
    renderBar("/insights");
    expect(screen.getByTestId("tab-coach")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("tab-log")).not.toHaveAttribute("aria-current");
  });

  it("highlights Coach on /observations/:id", () => {
    renderBar("/observations/abc123");
    expect(screen.getByTestId("tab-coach")).toHaveAttribute("aria-current", "page");
  });

  it("hides the Coach tab when coachEnabled is false", () => {
    mockCoach(false);
    renderBar("/");
    expect(screen.queryByTestId("tab-coach")).not.toBeInTheDocument();
    // The other three primary tabs still render.
    expect(screen.getByTestId("tab-log")).toBeInTheDocument();
    expect(screen.getByTestId("tab-today")).toBeInTheDocument();
    expect(screen.getByTestId("tab-journal")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("shows the Coach tab when coachEnabled is true", () => {
    mockCoach(true);
    renderBar("/");
    expect(screen.getByTestId("tab-coach")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe("activeTabForPath", () => {
  it("maps the primary routes", () => {
    expect(activeTabForPath("/")).toBe("log");
    expect(activeTabForPath("/today")).toBe("today");
    expect(activeTabForPath("/journal")).toBe("journal");
    expect(activeTabForPath("/coach")).toBe("coach");
  });

  it("maps Coach sub-routes to coach", () => {
    expect(activeTabForPath("/insights")).toBe("coach");
    expect(activeTabForPath("/observations")).toBe("coach");
    expect(activeTabForPath("/observations/xyz")).toBe("coach");
  });

  it("returns null for unrecognized / full-screen routes", () => {
    expect(activeTabForPath("/morning")).toBeNull();
    expect(activeTabForPath("/evening")).toBeNull();
    expect(activeTabForPath("/chat")).toBeNull();
  });
});

describe("showsBottomBar", () => {
  it("shows on the 4 primary destinations + Coach sub-routes", () => {
    for (const p of ["/", "/today", "/journal", "/coach", "/insights", "/observations"]) {
      expect(showsBottomBar(p)).toBe(true);
    }
  });

  it("hides on full-screen flows", () => {
    // Session runners + observation detail + the unlinked /chat.
    for (const p of ["/morning", "/evening", "/weekly", "/observations/abc", "/chat"]) {
      expect(showsBottomBar(p)).toBe(false);
    }
  });
});
