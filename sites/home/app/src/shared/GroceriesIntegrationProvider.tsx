/**
 * Bridges the recipes app's GroceriesIntegrationContext to the groceries app.
 * This allows recipes to add items to grocery lists when embedded in the home app.
 */
import type { ReactNode } from "react";
import { useGroceriesContext, addGroceryItem, setCurrentListId } from "@kirkl/groceries";
import { GroceriesIntegrationContext } from "@kirkl/recipes";
import { useAuth } from "@kirkl/shared";

interface GroceriesIntegrationProviderProps {
  children: ReactNode;
}

export function GroceriesIntegrationProvider({ children }: GroceriesIntegrationProviderProps) {
  const { state } = useGroceriesContext();
  const { user } = useAuth();

  const addItem = async (listId: string, ingredient: string, note?: string) => {
    if (!user) {
      throw new Error("User must be authenticated to add items");
    }
    // Set the current list ID for the firestore functions
    setCurrentListId(listId);
    await addGroceryItem(ingredient, user.uid, { note });
  };

  const integration = {
    userSlugs: state.userSlugs,
    currentListId: state.list?.id ?? null,
    addItem,
  };

  return (
    <GroceriesIntegrationContext.Provider value={integration}>
      {children}
    </GroceriesIntegrationContext.Provider>
  );
}
