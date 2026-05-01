/**
 * Shopping backend cache decorator.
 */
import type { ShoppingBackend } from "../interfaces/shopping";
import type { ShoppingList, ShoppingItem, HistoryEntry, ShoppingTrip } from "../types/shopping";
import type { Unsubscribe } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withShoppingCache(inner: ShoppingBackend): ShoppingBackend {
  return {
    // Reads
    getList: (id) => cachedRead<ShoppingList | null>(`shopping:list:${id}`, () => inner.getList(id)),

    // Writes — pass through.
    createList: (name, userId) => inner.createList(name, userId),
    renameList: (id, name) => inner.renameList(id, name),
    deleteList: (id) => inner.deleteList(id),
    updateCategories: (id, c) => inner.updateCategories(id, c),
    addItem: (listId, ing, userId, categoryId, note) => inner.addItem(listId, ing, userId, categoryId, note),
    updateItem: (id, u) => inner.updateItem(id, u),
    updateItemCategory: (id, listId, cat, ing) => inner.updateItemCategory(id, listId, cat, ing),
    toggleItem: (id, checked, userId) => inner.toggleItem(id, checked, userId),
    deleteItem: (id) => inner.deleteItem(id),
    clearCheckedItems: (id, items) => inner.clearCheckedItems(id, items),

    subscribeToList(listId, handlers): Unsubscribe {
      const listKey = `shopping:list:${listId}`;
      const itemsKey = `shopping:items:${listId}`;
      const historyKey = `shopping:history:${listId}`;
      const tripsKey = `shopping:trips:${listId}`;

      const listH = hydrateOne<ShoppingList>(listKey, handlers.onList);
      const itemsH = hydrateOne<ShoppingItem[]>(itemsKey, handlers.onItems);
      const historyH = hydrateOne<HistoryEntry[]>(historyKey, handlers.onHistory);
      const tripsH = hydrateOne<ShoppingTrip[]>(tripsKey, handlers.onTrips);

      return inner.subscribeToList(listId, {
        onList: cached(listKey, (l) => {
          listH.live();
          handlers.onList(l);
        }),
        onItems: cached(itemsKey, (i) => {
          itemsH.live();
          handlers.onItems(i);
        }),
        onHistory: cached(historyKey, (h) => {
          historyH.live();
          handlers.onHistory(h);
        }),
        onTrips: cached(tripsKey, (t) => {
          tripsH.live();
          handlers.onTrips(t);
        }),
        onDeleted: handlers.onDeleted,
      });
    },
  };
}
