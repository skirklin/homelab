/**
 * Backend provider for the travel app.
 * Creates PocketBase backends and exposes them via React context.
 */

import { createContext, useContext, type ReactNode } from "react";
import { getBackend } from "@kirkl/shared";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import type { TravelBackend } from "@homelab/backend";
import type { UserBackend } from "@homelab/backend";

const backends = createPocketBaseBackends(() => getBackend());

const TravelBackendContext = createContext<TravelBackend>(backends.travel);
const UserBackendContext = createContext<UserBackend>(backends.user);

export function BackendProvider({ children }: { children: ReactNode }) {
  return (
    <TravelBackendContext.Provider value={backends.travel}>
      <UserBackendContext.Provider value={backends.user}>
        {children}
      </UserBackendContext.Provider>
    </TravelBackendContext.Provider>
  );
}

export function useTravelBackend(): TravelBackend {
  return useContext(TravelBackendContext);
}

export function useUserBackend(): UserBackend {
  return useContext(UserBackendContext);
}
