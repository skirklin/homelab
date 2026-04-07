/**
 * Context for integrating recipes with shopping app.
 * When running standalone, this context is not provided (returns null).
 * When embedded in home app, the home app provides this context with access to shopping lists.
 */
import { createContext, useContext } from "react";

export interface ShoppingIntegration {
  /** User's shopping list slugs: { slug → listId } */
  userSlugs: Record<string, string>;
  /** Currently viewed list ID (if any) */
  currentListId: string | null;
  /** Add an item to a shopping list */
  addItem: (listId: string, ingredient: string, note?: string) => Promise<void>;
}

export const ShoppingIntegrationContext = createContext<ShoppingIntegration | null>(null);

/**
 * Hook to access shopping integration.
 * Returns null when running standalone (no shopping available).
 */
export function useShoppingIntegration(): ShoppingIntegration | null {
  return useContext(ShoppingIntegrationContext);
}
