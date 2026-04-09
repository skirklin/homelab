/**
 * Backend provider for the upkeep app.
 * Creates PocketBase backends and exposes them via React context.
 */

import { createContext, useContext, type ReactNode } from "react";
import { getBackend } from "@kirkl/shared";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import type { UpkeepBackend } from "@homelab/backend";
import type { UserBackend } from "@homelab/backend";

const backends = createPocketBaseBackends(() => getBackend());

const UpkeepBackendContext = createContext<UpkeepBackend>(backends.upkeep);
const UserBackendContext = createContext<UserBackend>(backends.user);

export function BackendProvider({ children }: { children: ReactNode }) {
  return (
    <UpkeepBackendContext.Provider value={backends.upkeep}>
      <UserBackendContext.Provider value={backends.user}>
        {children}
      </UserBackendContext.Provider>
    </UpkeepBackendContext.Provider>
  );
}

export function useUpkeepBackend(): UpkeepBackend {
  return useContext(UpkeepBackendContext);
}

export function useUserBackend(): UserBackend {
  return useContext(UserBackendContext);
}
