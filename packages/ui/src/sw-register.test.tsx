/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useUpdateAvailable, __resetSwRegisterForTests } from "./sw-register";
import { UpdateAvailableBanner } from "./update-available-banner";

function Probe() {
  const v = useUpdateAvailable();
  return <div data-testid="state">{v ? "available" : "none"}</div>;
}

describe("useUpdateAvailable + UpdateAvailableBanner", () => {
  beforeEach(() => {
    __resetSwRegisterForTests();
  });
  afterEach(() => {
    cleanup();
    __resetSwRegisterForTests();
  });

  it("starts false and the banner is hidden", () => {
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("none");
    render(<UpdateAvailableBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("flips to true when setUpdateAvailable fires from an installed SW", async () => {
    // We can't trigger a real SW lifecycle in jsdom, but the hook's contract
    // is "subscribers see updates to the module-scoped flag." Re-import via
    // the same module so the closure-private setter triggers our subscriber.
    const mod = await import("./sw-register");
    render(<Probe />);
    render(<UpdateAvailableBanner />);
    expect(screen.getByTestId("state").textContent).toBe("none");

    // Drive the module-scoped flag through the hook's only public path:
    // the subscriber list. We exercise via setUpdateAvailable, which is
    // exported indirectly through `useUpdateAvailable` re-render. Since
    // setUpdateAvailable isn't exported, we simulate by triggering a
    // re-render via a fresh listener add — the hook's initial state
    // sync covers this. To actually flip the flag, call a tiny helper
    // exposed for tests.
    act(() => {
      mod.__setUpdateAvailableForTests(true);
    });
    expect(screen.getByTestId("state").textContent).toBe("available");
    // Banner now mounts with the reload-pill role.
    expect(screen.getByRole("status").textContent).toContain("Update available");
  });
});
