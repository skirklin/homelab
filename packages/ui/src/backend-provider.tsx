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
import { getBackend } from "./backend";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import { withCache } from "@homelab/backend/cache";
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

export function BackendProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    registerServiceWorker();
    // Replay any persisted pending mutations from a prior session.
    // Safe-by-design: client-supplied IDs make creates idempotent, updates are
    // last-write-wins, deletes treat 404 as success.
    void wpb.replayPending();
  }, []);
  useTimezoneSync();
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
