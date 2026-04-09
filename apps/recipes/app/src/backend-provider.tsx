/**
 * Backend provider for the recipes app.
 * Creates PocketBase backends and exposes them via React context.
 */

import { createContext, useContext, type ReactNode } from "react";
import { getBackend } from "@kirkl/shared";
import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
import type { RecipesBackend } from "@homelab/backend";

const backends = createPocketBaseBackends(() => getBackend());

const RecipesBackendContext = createContext<RecipesBackend>(backends.recipes);

export function RecipesBackendProvider({ children }: { children: ReactNode }) {
  return (
    <RecipesBackendContext.Provider value={backends.recipes}>
      {children}
    </RecipesBackendContext.Provider>
  );
}

export function useRecipesBackend(): RecipesBackend {
  return useContext(RecipesBackendContext);
}
