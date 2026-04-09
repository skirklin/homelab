/**
 * Selector functions for deriving views from ShoppingState.
 */
import type { ShoppingState } from "./shopping-context";

export function getItemsFromState(state: ShoppingState) {
  return Array.from(state.items.values());
}

export function getItemsByCategoryId(state: ShoppingState) {
  const items = getItemsFromState(state);
  const grouped = new Map<string, typeof items>();
  for (const item of items) {
    const existing = grouped.get(item.categoryId) || [];
    existing.push(item);
    grouped.set(item.categoryId, existing);
  }
  return grouped;
}
