/**
 * Bridges the recipes app's ShoppingIntegrationContext to the shopping app.
 * This allows recipes to add items to shopping lists when embedded in the home app.
 */
import type { ReactNode } from "react";
import { useShoppingContext, useShoppingBackend } from "@kirkl/shopping";
import { ShoppingIntegrationContext } from "@kirkl/recipes";
import { useAuth } from "@kirkl/shared";

interface ShoppingIntegrationProviderProps {
  children: ReactNode;
}

export function ShoppingIntegrationProvider({ children }: ShoppingIntegrationProviderProps) {
  const { state } = useShoppingContext();
  const { user } = useAuth();
  const shopping = useShoppingBackend();

  const addItem = async (listId: string, ingredient: string, note?: string) => {
    if (!user) {
      throw new Error("User must be authenticated to add items");
    }
    await shopping.addItem(listId, ingredient, user.uid, { note });
  };

  const integration = {
    userSlugs: state.userSlugs,
    currentListId: state.list?.id ?? null,
    addItem,
  };

  return (
    <ShoppingIntegrationContext.Provider value={integration}>
      {children}
    </ShoppingIntegrationContext.Provider>
  );
}
