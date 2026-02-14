/**
 * Context for integrating recipes with groceries app.
 * When running standalone, this context is not provided (returns null).
 * When embedded in home app, the home app provides this context with access to grocery lists.
 */
import { createContext, useContext } from "react";

export interface GroceriesIntegration {
  /** User's grocery list slugs: { slug → listId } */
  userSlugs: Record<string, string>;
  /** Add an item to a grocery list */
  addItem: (listId: string, name: string) => Promise<void>;
}

export const GroceriesIntegrationContext = createContext<GroceriesIntegration | null>(null);

/**
 * Hook to access groceries integration.
 * Returns null when running standalone (no groceries available).
 */
export function useGroceriesIntegration(): GroceriesIntegration | null {
  return useContext(GroceriesIntegrationContext);
}
