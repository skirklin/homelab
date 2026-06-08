/**
 * @vitest-environment jsdom
 *
 * Render-gate tests for BackendProvider's hydration gate (useHydrationGate).
 *
 * The gate must NEVER leave the app behind a permanent blank screen. Both the
 * timeout-wins path (hydration hangs) and the hydrate-rejects path (IDB throws)
 * must flip the gate open so children render. We test the extracted hook in
 * isolation rather than rendering the full BackendProvider, which would
 * construct the real PocketBase backends at module scope.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useHydrationGate } from "./backend-provider";

function Gate({ hydrate, timeoutMs }: { hydrate: () => Promise<unknown>; timeoutMs?: number }) {
  const open = useHydrationGate(hydrate, timeoutMs);
  return <div>{open ? "children" : "blank"}</div>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHydrationGate render-gate", () => {
  it("renders children once hydration resolves", async () => {
    let resolve!: () => void;
    const hydrate = () => new Promise<void>((r) => { resolve = r; });
    render(<Gate hydrate={hydrate} />);
    // Before hydration settles, the gate is closed.
    expect(screen.getByText("blank")).toBeTruthy();

    await act(async () => { resolve(); await Promise.resolve(); });
    expect(screen.getByText("children")).toBeTruthy();
  });

  it("renders children when the timeout wins (hydration hangs forever)", async () => {
    vi.useFakeTimers();
    // A hydrate that never settles — only the timeout can open the gate.
    const hydrate = () => new Promise<void>(() => {});
    render(<Gate hydrate={hydrate} timeoutMs={1000} />);
    expect(screen.getByText("blank")).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("children")).toBeTruthy();
  });

  it("renders children when hydration REJECTS (IDB failure is non-fatal)", async () => {
    const hydrate = () => Promise.reject(new Error("IDB exploded"));
    render(<Gate hydrate={hydrate} />);

    // The rejection's .finally still flips the gate open — no permanent blank.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("children")).toBeTruthy();
  });
});
