import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/**
 * Cross-cutting scroll restoration for legacy `<BrowserRouter>` apps.
 *
 * React Router v6/v7's built-in `<ScrollRestoration />` only ships with the
 * data router API (`createBrowserRouter`); all of our apps use the legacy
 * declarative `<BrowserRouter>`, so we re-implement the standard behavior
 * here against `useLocation` + `useNavigationType`.
 *
 * Behavior:
 *   - PUSH/REPLACE: scroll to top.
 *   - POP (back/forward): restore the saved scroll position for that history
 *     entry, with a brief rAF retry while async content is still mounting.
 *   - Hash anchors (`/foo#section`): scroll the matching element into view,
 *     winning over both of the above.
 *
 * Scope:
 *   - Operates on the window scroll only — one scroll container per app.
 *     Apps with internal scroll containers would need a separate
 *     `data-scroll-restore-id` mechanism; intentionally out of scope.
 *   - Positions are kept in a module-level Map, so they survive route changes
 *     within a session but are dropped on full page reload. That matches user
 *     expectations: a refresh should land at the top, not mid-scroll.
 */

// Module-level cache keyed by React Router's `location.key`. Intentionally not
// persisted to sessionStorage — restoring across full reloads is a different
// problem and not what users expect after a refresh.
const scrollPositions = new Map<string, number>();

// Tell the browser to stop competing with us. Browsers run their own scroll
// heuristics on history navigation that don't compose with SPA routing — we
// take ownership instead.
if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

/**
 * Test seam: clear the in-memory cache. Not exported from the package barrel
 * — only used by `useScrollRestoration.test.tsx` to isolate tests.
 */
export function __resetScrollRestorationForTests(): void {
  scrollPositions.clear();
}

export function useScrollRestoration(): void {
  const location = useLocation();
  const navigationType = useNavigationType(); // "POP" | "PUSH" | "REPLACE"
  // Track the previous key across renders so the layout effect can save the
  // outgoing scroll position *before* it overwrites the scroll for the new
  // location. We can't use a `useEffect` cleanup for the save — that runs
  // after `useLayoutEffect`, by which point the scroll has already been reset.
  const previousKeyRef = useRef<string | null>(null);

  // Restore (or reset) on every key/hash change. useLayoutEffect so we beat
  // paint — otherwise users see a flash at scrollY=0 before we jump back.
  useLayoutEffect(() => {
    // Save the outgoing scroll position under the *previous* key first. On the
    // initial mount `previousKeyRef.current` is null and there's nothing to
    // save; on every subsequent navigation it points at the entry we're
    // leaving, and `window.scrollY` is still that entry's last scroll.
    if (previousKeyRef.current !== null && previousKeyRef.current !== location.key) {
      scrollPositions.set(previousKeyRef.current, window.scrollY);
    }
    previousKeyRef.current = location.key;

    if (location.hash) {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el) {
        el.scrollIntoView();
        return;
      }
      // Hash present but target missing — fall through to default behavior
      // rather than leave the scroll wherever it happened to be.
    }

    if (navigationType === "POP") {
      const saved = scrollPositions.get(location.key);
      if (saved !== undefined) {
        // Restore immediately. If the page is still shorter than `saved`
        // (data still loading), the browser will clamp to scrollHeight —
        // the rAF retry below covers the common case where content lands
        // within a few frames.
        window.scrollTo(0, saved);
        let tries = 0;
        const retry = () => {
          if (window.scrollY === saved) return; // already restored
          if (
            document.documentElement.scrollHeight >=
            saved + window.innerHeight
          ) {
            window.scrollTo(0, saved);
            return;
          }
          // ~100ms total at 60fps — enough for a typical data-fetch +
          // reconcile + paint round trip without becoming a janky animation
          // if the content never grows that tall.
          if (tries++ < 6) requestAnimationFrame(retry);
        };
        requestAnimationFrame(retry);
        return;
      }
    }

    // New navigation (PUSH/REPLACE), or POP with no saved position: top.
    window.scrollTo(0, 0);
  }, [location.key, location.hash, navigationType]);
}

/**
 * Drop-in component form. Render once inside a `<BrowserRouter>` (before
 * `<Routes>` is fine) for apps where adding a hook to the existing layout
 * tree is awkward.
 */
export function ScrollRestoration(): null {
  useScrollRestoration();
  return null;
}
