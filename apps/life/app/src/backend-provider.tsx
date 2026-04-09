/**
 * Backend provider for the life app.
 * Creates PocketBase backends and exposes them via React context.
 */

import { createContext, useContext, type ReactNode } from "react";
import { getBackend } from "@kirkl/shared";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import type { LifeBackend } from "@homelab/backend";
import type { UserBackend } from "@homelab/backend";

const backends = createPocketBaseBackends(() => getBackend());

const LifeBackendContext = createContext<LifeBackend>(backends.life);
const UserBackendContext = createContext<UserBackend>(backends.user);

export function BackendProvider({ children }: { children: ReactNode }) {
  return (
    <LifeBackendContext.Provider value={backends.life}>
      <UserBackendContext.Provider value={backends.user}>
        {children}
      </UserBackendContext.Provider>
    </LifeBackendContext.Provider>
  );
}

export function useLifeBackend(): LifeBackend {
  return useContext(LifeBackendContext);
}

export function useUserBackend(): UserBackend {
  return useContext(UserBackendContext);
}
