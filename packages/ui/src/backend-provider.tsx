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

const allBackends = createPocketBaseBackends(() => getBackend());
const wpb = allBackends.wpb;
const backends = withCache(allBackends);

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
 * Force a wpb.resync() on tab focus, pageshow, and on a slow interval while
 * the page is visible. Compensates for PocketBase's 5-minute realtime idle
 * disconnect + mobile-network SSE failures where the SDK's auto-reconnect
 * misses events (the symptom: one user adds an item, another user staring
 * at the same list never sees it until they refresh).
 */
function useRealtimeResync() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let inFlight: Promise<void> | null = null;
    const probe = () => {
      if (inFlight) return;
      inFlight = wpb.resync().catch(() => { /* offline or auth blip */ })
        .finally(() => { inFlight = null; });
    };

    // pageshow + focus cover phones returning from background (focus alone
    // misses bfcache restores on iOS); visibilitychange catches in-app tab
    // switches that fire neither.
    window.addEventListener("focus", probe);
    window.addEventListener("pageshow", probe);
    const visHandler = () => { if (document.visibilityState === "visible") probe(); };
    document.addEventListener("visibilitychange", visHandler);

    // Periodic probe so a foregrounded tab that's been idle past the 5-min
    // server-side disconnect still catches up without user interaction.
    const interval = setInterval(probe, 60 * 1000);

    return () => {
      window.removeEventListener("focus", probe);
      window.removeEventListener("pageshow", probe);
      document.removeEventListener("visibilitychange", visHandler);
      clearInterval(interval);
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
