/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import {
  ScrollRestoration,
  __resetScrollRestorationForTests,
} from "./useScrollRestoration";

// ---- Harness ----------------------------------------------------------------
//
// jsdom's `window.scrollTo` is a no-op and `scrollY` is read-only and stuck at
// 0. We replace both so the hook can read/write scroll like in a real browser.

let scrollY = 0;
const scrollToSpy = vi.fn();

function installScrollShim() {
  scrollY = 0;
  scrollToSpy.mockReset();
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => scrollY,
  });
  window.scrollTo = ((x: number, y: number) => {
    scrollToSpy(x, y);
    scrollY = y;
  }) as typeof window.scrollTo;
}

/**
 * Captures the imperative `navigate` so a test can drive PUSH / back / forward
 * without rerendering against a different `<MemoryRouter>` initial entry —
 * crucial because the module-level position cache only sees navigations within
 * a single router instance's history.
 */
let navigateRef: ReturnType<typeof useNavigate> | null = null;

function CaptureNavigate() {
  navigateRef = useNavigate();
  return null;
}

interface PageProps {
  name: string;
  onMount?: () => void;
}

function Page({ name, onMount }: PageProps) {
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  return <div data-testid={`page-${name}`}>{name}</div>;
}

function renderApp(initialEntries: string[] = ["/a"], extra?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ScrollRestoration />
      <CaptureNavigate />
      <Routes>
        <Route path="/a" element={<Page name="a" />} />
        <Route path="/b" element={<Page name="b" />} />
        <Route path="/c" element={<Page name="c" />} />
        <Route
          path="/anchor"
          element={
            <div>
              <div style={{ height: 2000 }} />
              <div id="target" data-testid="target">
                target
              </div>
            </div>
          }
        />
      </Routes>
      {extra}
    </MemoryRouter>,
  );
}

// ---- Tests ------------------------------------------------------------------

describe("useScrollRestoration", () => {
  beforeEach(() => {
    installScrollShim();
    __resetScrollRestorationForTests();
    navigateRef = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("scrolls to top on PUSH navigation", () => {
    renderApp(["/a"]);
    // The initial mount triggers a scrollTo(0,0) for the first key — clear it
    // so we're only asserting on the PUSH that follows.
    scrollToSpy.mockClear();

    act(() => {
      navigateRef!("/b");
    });

    // The only scroll write triggered by the PUSH should be (0, 0).
    const lastCall = scrollToSpy.mock.calls.at(-1);
    expect(lastCall).toEqual([0, 0]);
  });

  it("leaves scroll alone on PUSH with state.preserveScroll", () => {
    renderApp(["/a"]);
    act(() => {
      scrollY = 300;
    });
    scrollToSpy.mockClear();

    act(() => {
      navigateRef!("/b", { state: { preserveScroll: true } });
    });

    // The opt-out short-circuits before any scroll write.
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(scrollY).toBe(300);
  });

  it("leaves scroll alone on REPLACE with state.preserveScroll (life day-stepping)", () => {
    // useUrlParam writes the life `?date=` param in replace mode with
    // state.preserveScroll; that REPLACE nav must NOT scroll to top.
    renderApp(["/a"]);
    act(() => {
      scrollY = 420;
    });
    scrollToSpy.mockClear();

    act(() => {
      navigateRef!("/b", { replace: true, state: { preserveScroll: true } });
    });

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(scrollY).toBe(420);
  });

  it("restores the previous scroll position on POP (back)", () => {
    renderApp(["/a"]);

    // Simulate the user scrolling down on /a, then navigating to /b.
    act(() => {
      scrollY = 500;
    });
    act(() => {
      navigateRef!("/b");
    });
    // After PUSH we're back at 0, mirroring what the hook itself just did.
    expect(scrollY).toBe(0);

    scrollToSpy.mockClear();

    // Back to /a — the hook should restore us to 500.
    act(() => {
      navigateRef!(-1);
    });

    // First scrollTo of the POP should be the restore. (Subsequent rAF retries
    // may run but won't change anything because scrollY is already 500.)
    expect(scrollToSpy.mock.calls[0]).toEqual([0, 500]);
    expect(scrollY).toBe(500);
  });

  it("scrolls a hash anchor into view when present", () => {
    const scrollIntoViewSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView on elements either.
    // Patch the prototype before render so the element picks it up.
    Element.prototype.scrollIntoView = scrollIntoViewSpy as never;

    renderApp(["/anchor#target"]);

    expect(scrollIntoViewSpy).toHaveBeenCalled();
    // And we should NOT have done a window.scrollTo(0, 0) on top of it.
    // (Initial mount sets currentKeyRef but the hash branch returns early
    // before falling through to the new-navigation scrollTo.)
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("retains cached positions across unmount/remount within the same session", () => {
    // First mount: walk a → b with scroll on /a. The save-on-navigation logic
    // stores /a's scrollY=720 under its router key in the module-level cache.
    const { unmount } = renderApp(["/a"]);
    act(() => {
      scrollY = 720;
    });
    act(() => {
      navigateRef!("/b");
    });

    // Sanity: inside this render, going back restores 720 (already covered by
    // the POP test, but worth confirming the precondition for the remount).
    scrollToSpy.mockClear();
    act(() => {
      navigateRef!(-1);
    });
    expect(scrollToSpy.mock.calls[0]).toEqual([0, 720]);

    // Now unmount the whole router. The module-level scrollPositions Map
    // should still hold the saved position. If we remount and the second
    // router reuses the same initial key (MemoryRouter assigns "default" to
    // its first entry, deterministically), POP-ing within that second mount
    // should restore the cached value instead of starting from scratch.
    unmount();
    installScrollShim();
    renderApp(["/a"]);
    // Drive a fresh PUSH then POP — if the cache was wiped we'd land at 0.
    act(() => {
      navigateRef!("/b");
    });
    scrollToSpy.mockClear();
    act(() => {
      navigateRef!(-1);
    });
    expect(scrollToSpy.mock.calls[0]).toEqual([0, 720]);
  });
});
