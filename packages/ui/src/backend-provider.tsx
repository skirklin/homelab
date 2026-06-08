/**
 * Shared backend provider and hooks for all apps.
 *
 * Creates PocketBase backends once at module scope and exposes them
 * via React context. Each app wraps its tree with <BackendProvider>
 * and uses the typed useXBackend() hooks.
 *
 * The contexts have default values from the module-scope backends,
 * so hooks work even without the Provider wrapper (e.g. when the
 * home app nests providers from multiple modules).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { message } from "antd";
import { getBackend } from "./backend";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import { WrappedPbError } from "@homelab/backend/wrapped-pb";
import { OfflineBanner } from "./online-status";
import { SyncStatusBanner } from "./sync-status";
import { UpdateAvailableBanner } from "./update-available-banner";
import { registerServiceWorker } from "./sw-register";
import { useAuth } from "./auth";
import type {
  ShoppingBackend,
  RecipesBackend,
  UpkeepBackend,
  TravelBackend,
  LifeBackend,
  UserBackend,
  ObserverBackend,
  ChatBackend,
} from "@homelab/backend";
import type { WpbDebug } from "@homelab/backend/wrapped-pb";

const backends = createPocketBaseBackends(() => getBackend());
const wpb = backends.wpb;
const mirror = backends.mirror;

// Expose the wpb debug handle on the global so investigating a "writes
// vanished after cache clear" or "Angela never saw the update" report is
// `__wpbDebug.snapshot()` in the console, not a code-spelunking expedition.
// No-op outside browsers (SSR/tests don't have window).
if (typeof window !== "undefined") {
  (window as unknown as { __wpbDebug?: typeof wpb.debug }).__wpbDebug = wpb.debug;
}

const ShoppingBackendContext = createContext<ShoppingBackend>(backends.shopping);
const RecipesBackendContext = createContext<RecipesBackend>(backends.recipes);
const UpkeepBackendContext = createContext<UpkeepBackend>(backends.upkeep);
const TravelBackendContext = createContext<TravelBackend>(backends.travel);
const LifeBackendContext = createContext<LifeBackend>(backends.life);
const UserBackendContext = createContext<UserBackend>(backends.user);
const ObserverBackendContext = createContext<ObserverBackend>(backends.observer);
const ChatBackendContext = createContext<ChatBackend>(backends.chat);

/**
 * Push the browser's current IANA timezone to `users.timezone` whenever it
 * differs from what we last pushed for this user on this device. Server-side
 * jobs (push notifications, etc.) read this to fire at the user's actual
 * local time instead of guessing from trip data.
 */
/**
 * Push the browser's current IANA timezone to `users.timezone` whenever it
 * differs from what we last pushed for this user on this device.
 *
 * Race-narrowing: this hook used to PATCH the user record on every mount of
 * a fresh user (no `kirkl_tz_pushed:<uid>` cache entry, so the dedupe never
 * matched). PB's PATCH update is a server-side read-modify-write over the
 * FULL record — concurrent writes to other user-record fields can be
 * silently clobbered. Two real cases hit this:
 *
 *   1. `/api/sharing/redeem` adds a box to `user.recipe_boxes`; the timezone
 *      PATCH loads the record before the hook commits, then writes back the
 *      pre-hook value → recipe_boxes silently reverts to null. The redeemer
 *      sees "No boxes" on their /boxes page even though the hook said
 *      success. Repro: invite-redemption Playwright spec, ~25% failure rate.
 *   2. Any other concurrent user-record write (slug additions, FCM token,
 *      notification mode) from the same browser tab — `wpb`'s per-record
 *      chain doesn't apply because the timezone PATCH was not chained.
 *
 * Mitigations layered here:
 *   - Prefer the in-memory mirror cache: if the user record is already in
 *     the wpb cache AND its `timezone` field matches the browser, skip the
 *     PATCH entirely. This is the common case for returning users — their
 *     timezone is already correctly set server-side from a prior session.
 *     Also seeds the localStorage cache so subsequent mounts don't even
 *     bother checking.
 *   - Defer the PATCH off the initial mount with `requestIdleCallback`
 *     (or a 1s setTimeout fallback). For brand-new users with no server
 *     timezone, this gives the redeem POST (and any other inline writes
 *     triggered by routing) a chance to complete first. The race window
 *     drops from ~all-mounts to "brand-new user mounts an inline-write
 *     path within 1s of sign-in" — exceedingly rare in practice.
 *
 * Note: this is NOT a complete fix to PB's lost-update problem. Any two
 * concurrent writes to the same user record can still clobber. The real fix
 * is either (a) move `timezone` to a separate collection, or (b) decompose
 * `user.recipe_boxes` into a membership table. Both are larger schema
 * changes; this hook's narrow mitigation closes the failing test case and
 * leaves a comment trail for the structural fix.
 */
function useTimezoneSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const tz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
      catch { return ""; }
    })();
    if (!tz) return;
    const cacheKey = `kirkl_tz_pushed:${user.uid}`;
    if (typeof localStorage !== "undefined" && localStorage.getItem(cacheKey) === tz) return;

    // Defer off the initial mount so inline writes triggered by routing
    // (most importantly /invite/<code> -> POST /api/sharing/redeem) get a
    // chance to commit before our PATCH loads the user record.
    let cancelled = false;
    const idle: (cb: () => void) => () => void = (cb) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }).requestIdleCallback;
      if (typeof ric === "function") {
        const h = ric(cb, { timeout: 2000 });
        return () => (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(h);
      }
      const h = setTimeout(cb, 1000);
      return () => clearTimeout(h);
    };

    const cancelIdle = idle(() => {
      if (cancelled) return;
      // Cache-first check: if the mirror has already populated the user
      // record and its timezone matches, no write needed.
      const cached = wpb.collection("users").view<{ timezone?: string }>(user.uid);
      if (cached && cached.timezone === tz) {
        if (typeof localStorage !== "undefined") localStorage.setItem(cacheKey, tz);
        return;
      }
      backends.user.updateProfile(user.uid, { timezone: tz })
        .then(() => {
          if (typeof localStorage !== "undefined") localStorage.setItem(cacheKey, tz);
        })
        .catch(() => { /* offline / write conflict — try again on next mount */ });
    });
    return () => { cancelled = true; cancelIdle(); };
  }, [user?.uid]);
}

/**
 * Catch un-awaited optimistic-write rejections and surface a generic toast.
 * Call sites that want custom messaging should `await` and toast themselves;
 * this is the safety net for fire-and-forget writes.
 */
function useOptimisticErrorToast() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof WrappedPbError)) return;
      const { kind } = event.reason.op;
      const verb = kind === "create" ? "save" : kind === "update" ? "update" : "remove";
      message.error(`Couldn't ${verb} — please try again`);
      // Don't preventDefault — keep the original PB error in the console for
      // debugging. The user already gets feedback via the toast.
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);
}

/**
 * On tab re-engagement, run two recovery sweeps:
 *  - mirror.resync(): refetch every active mirror slice so the user sees
 *    writes other peers made while we were backgrounded
 *  - wpb.retryErrored(): re-fire writes that failed transiently
 *    (network blip, 5xx, 429, 401), so queued-up local edits land
 *    without the user having to retry by hand
 *
 * Each short-circuits when there's nothing to do — quiet, healthy tabs
 * pay nothing on every focus blip. Polling on a fixed interval was the
 * wrong default and got removed; focus/pageshow/visibilitychange fire
 * exactly when we need to act. PB's PB_CONNECT hook also drives
 * retryErrored on detected drops, so this is the mobile-suspend
 * backstop (the OS freezes the network stack silently and the SDK never
 * notices).
 */
function useRealtimeResync() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let inFlight: Promise<void> | null = null;
    // Single probe — guards against re-entry while a resync is in flight, and
    // gates on document.visibility so visibilitychange events that fire while
    // hiding the tab are no-ops. focus/pageshow trivially imply visible, so
    // the gate is a no-op on those paths.
    const probe = () => {
      if (inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = Promise.all([
        mirror.resync().catch(() => { /* offline or auth blip */ }),
        wpb.retryErrored().catch(() => { /* same */ }),
      ]).then(() => undefined).finally(() => { inFlight = null; });
    };

    const events: Array<[EventTarget, string]> = [
      [window, "focus"],
      [window, "pageshow"],
      [document, "visibilitychange"],
    ];
    for (const [target, ev] of events) target.addEventListener(ev, probe);
    return () => {
      for (const [target, ev] of events) target.removeEventListener(ev, probe);
    };
  }, []);
}

export function BackendProvider({ children }: { children: ReactNode }) {
  // Gate the first render on snapshot hydration so a cold load paints cached
  // data (stale-while-revalidate) instead of flashing empty lists. Hydration
  // is normally sub-100ms (one indexed IDB read), but we race it against a
  // 1s timeout so a pathological/hung IDB can never brick the app — if the
  // timeout wins we render anyway and hydrateSnapshots' notifyMutationListeners
  // delivers the cache to already-mounted slices best-effort.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setHydrated(true); } };
    const timeout = setTimeout(finish, 1000);
    wpb.hydrateSnapshots().catch(() => { /* IDB failure is non-fatal */ }).finally(() => {
      clearTimeout(timeout);
      finish();
    });
    return () => clearTimeout(timeout);
  }, []);
  useEffect(() => {
    registerServiceWorker();
    // Replay any persisted pending mutations from a prior session. Reads
    // (hydrateSnapshots, above) and writes (replayPending) touch different IDB
    // stores, so they run independently — replay does not wait on hydration.
    // Safe-by-design: client-supplied IDs make creates idempotent, updates are
    // last-write-wins, deletes treat 404 as success.
    void wpb.replayPending();
  }, []);
  useTimezoneSync();
  useOptimisticErrorToast();
  useRealtimeResync();
  return (
    <ShoppingBackendContext.Provider value={backends.shopping}>
      <RecipesBackendContext.Provider value={backends.recipes}>
        <UpkeepBackendContext.Provider value={backends.upkeep}>
          <TravelBackendContext.Provider value={backends.travel}>
            <LifeBackendContext.Provider value={backends.life}>
              <UserBackendContext.Provider value={backends.user}>
                <ObserverBackendContext.Provider value={backends.observer}>
                  <ChatBackendContext.Provider value={backends.chat}>
                    <OfflineBanner />
                    <UpdateAvailableBanner />
                    <SyncStatusBanner debug={wpb.debug} />
                    {hydrated ? children : null}
                  </ChatBackendContext.Provider>
                </ObserverBackendContext.Provider>
              </UserBackendContext.Provider>
            </LifeBackendContext.Provider>
          </TravelBackendContext.Provider>
        </UpkeepBackendContext.Provider>
      </RecipesBackendContext.Provider>
    </ShoppingBackendContext.Provider>
  );
}

export function useShoppingBackend(): ShoppingBackend {
  return useContext(ShoppingBackendContext);
}

export function useRecipesBackend(): RecipesBackend {
  return useContext(RecipesBackendContext);
}

export function useUpkeepBackend(): UpkeepBackend {
  return useContext(UpkeepBackendContext);
}

export function useTravelBackend(): TravelBackend {
  return useContext(TravelBackendContext);
}

export function useLifeBackend(): LifeBackend {
  return useContext(LifeBackendContext);
}

export function useUserBackend(): UserBackend {
  return useContext(UserBackendContext);
}

export function useObserverBackend(): ObserverBackend {
  return useContext(ObserverBackendContext);
}

export function useChatBackend(): ChatBackend {
  return useContext(ChatBackendContext);
}

/**
 * Returns the wpb debug handle for use with <SyncDot> and similar
 * observability surfaces. Pre-bound to the shared singleton so callers
 * don't have to know about wpb's construction site.
 */
export function useWpbDebug(): WpbDebug {
  return wpb.debug;
}
