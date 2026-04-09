/**
 * Firebase/Firestore implementation of ShoppingBackend.
 *
 * Data model (Firestore):
 *   lists/{listId}                  — list metadata (name, owners, categoryDefs)
 *   lists/{listId}/items/{itemId}   — individual shopping items
 *   lists/{listId}/history/{key}    — ingredient history (keyed by normalized ingredient)
 *   lists/{listId}/trips/{tripId}   — completed shopping trips
 *   users/{userId}                  — user profile with slugs
 */
import {
  collection,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  updateDoc,
  addDoc,
  writeBatch,
  onSnapshot,
  query,
  orderBy,
  limit,
  Timestamp,
  type Firestore,
} from "firebase/firestore";
import type { ShoppingBackend } from "../interfaces/shopping";
import type {
  ShoppingList,
  ShoppingItem,
  CategoryDef,
  HistoryEntry,
  ShoppingTrip,
} from "../types/shopping";
import type { Unsubscribe } from "../types/common";

function normalizeIngredient(ingredient: string): string {
  return ingredient.toLowerCase().trim();
}

export class FirebaseShoppingBackend implements ShoppingBackend {
  constructor(private db: Firestore) {}

  private listRef(listId: string) {
    return doc(this.db, "lists", listId);
  }
  private itemsRef(listId: string) {
    return collection(this.db, "lists", listId, "items");
  }
  private itemRef(listId: string, itemId: string) {
    return doc(this.db, "lists", listId, "items", itemId);
  }
  private historyRef(listId: string) {
    return collection(this.db, "lists", listId, "history");
  }
  private historyEntryRef(listId: string, ingredient: string) {
    return doc(this.db, "lists", listId, "history", normalizeIngredient(ingredient));
  }
  private tripsRef(listId: string) {
    return collection(this.db, "lists", listId, "trips");
  }

  async createList(name: string, userId: string): Promise<string> {
    const listsRef = collection(this.db, "lists");
    const newListRef = doc(listsRef);
    await setDoc(newListRef, {
      name,
      owners: [userId],
      categoryDefs: [],
      created: Timestamp.now(),
      updated: Timestamp.now(),
    });
    return newListRef.id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    await updateDoc(this.listRef(listId), { name, updated: Timestamp.now() });
  }

  async deleteList(listId: string): Promise<void> {
    await deleteDoc(this.listRef(listId));
  }

  async getList(listId: string): Promise<ShoppingList | null> {
    const snap = await getDoc(this.listRef(listId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      id: snap.id,
      name: data.name || "",
      owners: data.owners || [],
      categories: data.categoryDefs || [],
    };
  }

  async updateCategories(listId: string, categories: CategoryDef[]): Promise<void> {
    await updateDoc(this.listRef(listId), { categoryDefs: categories });
  }

  async addItem(
    listId: string,
    ingredient: string,
    userId: string,
    options?: { categoryId?: string; note?: string },
  ): Promise<string> {
    let categoryId = options?.categoryId || "uncategorized";

    if (!options?.categoryId) {
      const historySnap = await getDoc(this.historyEntryRef(listId, ingredient));
      if (historySnap.exists()) {
        categoryId = historySnap.data().categoryId || "uncategorized";
      }
    }

    const itemRef = doc(this.itemsRef(listId));
    await setDoc(itemRef, {
      ingredient,
      ...(options?.note ? { note: options.note } : {}),
      categoryId,
      checked: false,
      addedBy: userId,
      addedAt: Timestamp.now(),
    });

    // Save to history
    await setDoc(this.historyEntryRef(listId, ingredient), {
      ingredient,
      categoryId,
      lastAdded: Timestamp.now(),
    });

    return itemRef.id;
  }

  async updateItem(itemId: string, updates: { ingredient?: string; note?: string }): Promise<void> {
    // We need the listId — Firebase items are subcollections.
    // This is a design tension: the interface doesn't require listId for updateItem.
    // In practice, the caller always has it in context. We store it on the item.
    // For now, we need to search or require it passed differently.
    // WORKAROUND: Store listId on the class instance when subscribeToList is called.
    const data: Record<string, string | null> = {};
    if (updates.ingredient !== undefined) data.ingredient = updates.ingredient;
    if (updates.note !== undefined) data.note = updates.note || null;
    await updateDoc(doc(this.db, "lists", this._activeListId, "items", itemId), data);
  }

  async updateItemCategory(itemId: string, categoryId: string, ingredient: string): Promise<void> {
    const listId = this._activeListId;
    await updateDoc(this.itemRef(listId, itemId), { categoryId });
    await setDoc(this.historyEntryRef(listId, ingredient), {
      ingredient,
      categoryId,
      lastAdded: Timestamp.now(),
    });
  }

  async toggleItem(itemId: string, checked: boolean, userId: string): Promise<void> {
    const ref = this.itemRef(this._activeListId, itemId);
    if (checked) {
      await updateDoc(ref, {
        checked: true,
        checkedBy: userId,
        checkedAt: Timestamp.now(),
      });
    } else {
      await updateDoc(ref, {
        checked: false,
        checkedBy: null,
        checkedAt: null,
      });
    }
  }

  async deleteItem(itemId: string): Promise<void> {
    await deleteDoc(this.itemRef(this._activeListId, itemId));
  }

  async clearCheckedItems(listId: string, items: ShoppingItem[]): Promise<void> {
    const checkedItems = items.filter((item) => item.checked);
    if (checkedItems.length === 0) return;

    // Record shopping trip
    await addDoc(this.tripsRef(listId), {
      completedAt: Timestamp.now(),
      items: checkedItems.map((item) => ({
        ingredient: item.ingredient,
        ...(item.note ? { note: item.note } : {}),
        categoryId: item.categoryId,
      })),
    });

    // Batch-delete checked items
    const batch = writeBatch(this.db);
    for (const item of checkedItems) {
      batch.delete(this.itemRef(listId, item.id));
    }
    await batch.commit();
  }

  // Track which list is active for operations that need it implicitly
  private _activeListId = "";

  subscribeToList(
    listId: string,
    handlers: {
      onList: (list: ShoppingList) => void;
      onItems: (items: ShoppingItem[]) => void;
      onHistory: (entries: HistoryEntry[]) => void;
      onTrips: (trips: ShoppingTrip[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    this._activeListId = listId;
    const unsubs: Array<() => void> = [];

    // List metadata
    unsubs.push(
      onSnapshot(this.listRef(listId), (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          handlers.onList({
            id: snap.id,
            name: data.name || "",
            owners: data.owners || [],
            categories: data.categoryDefs || [],
          });
        } else {
          handlers.onDeleted?.();
        }
      }),
    );

    // Items — Firebase onSnapshot delivers full state via docChanges
    const itemsMap = new Map<string, ShoppingItem>();
    unsubs.push(
      onSnapshot(this.itemsRef(listId), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            itemsMap.delete(change.doc.id);
          } else {
            const data = change.doc.data();
            itemsMap.set(change.doc.id, {
              id: change.doc.id,
              list: listId,
              ingredient: data.ingredient || "",
              note: data.note || "",
              categoryId: data.categoryId || "uncategorized",
              checked: !!data.checked,
              checkedBy: data.checkedBy || undefined,
              checkedAt: data.checkedAt?.toDate?.()?.toISOString() || undefined,
              addedBy: data.addedBy || undefined,
            });
          }
        });
        handlers.onItems(Array.from(itemsMap.values()));
      }),
    );

    // History
    unsubs.push(
      onSnapshot(this.historyRef(listId), (snapshot) => {
        const entries: HistoryEntry[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ingredient: data.ingredient || data.name || "",
            categoryId: data.categoryId || "uncategorized",
            lastAdded: data.lastAdded?.toDate?.() || new Date(),
          };
        });
        entries.sort((a, b) => b.lastAdded.getTime() - a.lastAdded.getTime());
        handlers.onHistory(entries);
      }),
    );

    // Trips — most recent 50
    const tripsQuery = query(this.tripsRef(listId), orderBy("completedAt", "desc"), limit(50));
    unsubs.push(
      onSnapshot(tripsQuery, (snapshot) => {
        const trips: ShoppingTrip[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            list: listId,
            completedAt: data.completedAt?.toDate?.() || new Date(),
            items: (data.items || []).map((item: Record<string, string>) => ({
              ingredient: item.ingredient || item.name || "",
              note: item.note || "",
              categoryId: item.categoryId || "uncategorized",
            })),
          };
        });
        handlers.onTrips(trips);
      }),
    );

    return () => unsubs.forEach((u) => u());
  }
}
