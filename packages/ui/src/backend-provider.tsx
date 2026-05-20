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

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { message } from "antd";
import { getBackend } from "./backend";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import { withCache } from "@homelab/backend/cache";
import { WrappedPbError } from "@homelab/backend/wrapped-pb";
import { OfflineBanner } from "./online-status";
import { SyncStatusBanner } from "./sync-status";
import { registerServiceWorker } from "./sw-register";
import { useAuth } from "./auth";
import type {
  ShoppingBackend,
  RecipesBackend,
  UpkeepBackend,
  TravelBackend,
  LifeBackend,
  UserBackend,
} from "@homelab/backend";
import type { WpbDebug } from "@homelab/backend/wrapped-pb";

const allBackends = createPocketBaseBackends(() => getBackend());
const wpb = allBackends.wpb;
const backends = withCache(allBackends);

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

/**
 * Push the browser's current IANA timezone to `users.timezone` whenever it
 * differs from what we last pushed for this user on this device. Server-side
 * jobs (push notifications, etc.) read this to fire at the user's actual
 * local time instead of guessing from trip data.
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
    backends.user.updateProfile(user.uid, { timezone: tz })
      .then(() => {
        if (typeof localStorage !== "undefined") localStorage.setItem(cacheKey, tz);
      })
      .catch(() => { /* offline / write conflict — try again on next mount */ });
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
 * On tab re-engagement, run wpb's two recovery sweeps:
 *  - resync(): refetch active subscriptions if SSE has gone idle, so the
 *    user sees writes other peers made while we were backgrounded
 *  - retryErrored(): re-fire writes that failed transiently (network
 *    blip, 5xx, 429, 401), so queued-up local edits land without the
 *    user having to retry by hand
 *
 * Both short-circuit when there's nothing to do — quiet, healthy tabs
 * pay nothing on every focus blip. Polling on a fixed interval was the
 * wrong default and got removed; focus/pageshow/visibilitychange fire
 * exactly when we need to act. The PB SDK's onDisconnect+PB_CONNECT hook
 * already drives both on detected drops, so this is the mobile-suspend
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
        wpb.resync().catch(() => { /* offline or auth blip */ }),
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
  useEffect(() => {
    registerServiceWorker();
    // Replay any persisted pending mutations from a prior session.
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
                <OfflineBanner />
                <SyncStatusBanner debug={wpb.debug} />
                {children}
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

/**
 * Returns the wpb debug handle for use with <SyncDot> and similar
 * observability surfaces. Pre-bound to the shared singleton so callers
 * don't have to know about wpb's construction site.
 */
export function useWpbDebug(): WpbDebug {
  return wpb.debug;
}
