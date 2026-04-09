/**
 * Backend provider for the shopping app.
 * Creates PocketBase backends and exposes them via React context.
 */

import { createContext, useContext, type ReactNode } from "react";
import { getBackend } from "@kirkl/shared";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import type { ShoppingBackend } from "@homelab/backend";
import type { UserBackend } from "@homelab/backend";

const backends = createPocketBaseBackends(() => getBackend());

const ShoppingBackendContext = createContext<ShoppingBackend>(backends.shopping);
const UserBackendContext = createContext<UserBackend>(backends.user);

export function BackendProvider({ children }: { children: ReactNode }) {
  return (
    <ShoppingBackendContext.Provider value={backends.shopping}>
      <UserBackendContext.Provider value={backends.user}>
        {children}
      </UserBackendContext.Provider>
    </ShoppingBackendContext.Provider>
  );
}

export function useShoppingBackend(): ShoppingBackend {
  return useContext(ShoppingBackendContext);
}

export function useUserBackend(): UserBackend {
  return useContext(UserBackendContext);
}
