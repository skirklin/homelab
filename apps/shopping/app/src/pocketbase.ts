/**
 * PocketBase data operations for the shopping app.
 * Replaces the old firestore.ts.
 */
import { getBackend } from "@kirkl/shared";
import type { ShoppingItem, CategoryDef, CategoryId } from "./types";

// Current list ID - set by the router
let currentListId = "default";

export function setCurrentListId(listId: string) {
  currentListId = listId;
}

export function getCurrentListId() {
  return currentListId;
}

function pb() {
  return getBackend();
}

function normalizeIngredient(ingredient: string): string {
  return ingredient.toLowerCase().trim();
}

// ===== List operations =====

export async function ensureListExists(userId: string) {
  try {
    const list = await pb().collection("shopping_lists").getOne(currentListId);
    const owners = Array.isArray(list.owners) ? list.owners : [list.owners];
    if (!owners.includes(userId)) {
      await pb().collection("shopping_lists").update(currentListId, {
        owners: [...owners, userId],
      });
    }
  } catch {
    // List doesn't exist — don't auto-create
  }
}

export async function createList(name: string, slug: string, userId: string): Promise<string> {
  const opts = { $autoCancel: false };
  const list = await pb().collection("shopping_lists").create({
    name,
    owners: [userId],
    category_defs: [],
  }, opts);

  await setUserSlug(userId, slug, list.id, opts);
  return list.id;
}

export async function renameList(listId: string, newName: string) {
  await pb().collection("shopping_lists").update(listId, { name: newName });
}

export async function deleteList(listId: string) {
  await pb().collection("shopping_lists").delete(listId);
}

export async function getListById(listId: string): Promise<{ name: string } | null> {
  try {
    const list = await pb().collection("shopping_lists").getOne(listId);
    return { name: list.name };
  } catch {
    return null;
  }
}

export async function updateCategories(categories: CategoryDef[]) {
  await pb().collection("shopping_lists").update(currentListId, {
    category_defs: categories,
  });
}

// ===== Item operations =====

export async function addItem(
  ingredient: string,
  userId: string,
  options?: { itemId?: string; categoryId?: string; note?: string }
) {
  const opts = { $autoCancel: false };
  let categoryId: string = options?.categoryId || "uncategorized";

  if (!options?.categoryId) {
    // Look up category from history
    try {
      const history = await pb().collection("shopping_history").getFirstListItem(
        `list = "${currentListId}" && ingredient = "${normalizeIngredient(ingredient)}"`,
        opts,
      );
      categoryId = history.category_id || "uncategorized";
    } catch {
      // No history found
    }
  }

  await pb().collection("shopping_items").create({
    list: currentListId,
    ingredient,
    note: options?.note || "",
    category_id: categoryId,
    checked: false,
    added_by: userId,
  }, opts);

  // Save to history
  try {
    const existing = await pb().collection("shopping_history").getFirstListItem(
      `list = "${currentListId}" && ingredient = "${normalizeIngredient(ingredient)}"`,
      opts,
    );
    await pb().collection("shopping_history").update(existing.id, {
      category_id: categoryId,
      last_added: new Date().toISOString(),
    }, opts);
  } catch {
    await pb().collection("shopping_history").create({
      list: currentListId,
      ingredient: normalizeIngredient(ingredient),
      category_id: categoryId,
      last_added: new Date().toISOString(),
    }, opts);
  }
}

export async function toggleItem(item: ShoppingItem, userId: string) {
  if (item.checked) {
    await pb().collection("shopping_items").update(item.id, {
      checked: false,
      checked_by: "",
      checked_at: "",
    });
  } else {
    await pb().collection("shopping_items").update(item.id, {
      checked: true,
      checked_by: userId,
      checked_at: new Date().toISOString(),
    });
  }
}

export async function deleteItem(itemId: string) {
  await pb().collection("shopping_items").delete(itemId);
}

export async function updateItem(itemId: string, updates: { ingredient?: string; note?: string }) {
  const data: Record<string, string> = {};
  if (updates.ingredient !== undefined) data.ingredient = updates.ingredient;
  if (updates.note !== undefined) data.note = updates.note || "";
  await pb().collection("shopping_items").update(itemId, data);
}

export async function updateItemCategory(item: ShoppingItem, newCategoryId: CategoryId) {
  await pb().collection("shopping_items").update(item.id, { category_id: newCategoryId });

  // Update history
  try {
    const existing = await pb().collection("shopping_history").getFirstListItem(
      `list = "${currentListId}" && ingredient = "${normalizeIngredient(item.ingredient)}"`
    );
    await pb().collection("shopping_history").update(existing.id, {
      category_id: newCategoryId,
      last_added: new Date().toISOString(),
    });
  } catch {
    await pb().collection("shopping_history").create({
      list: currentListId,
      ingredient: normalizeIngredient(item.ingredient),
      category_id: newCategoryId,
      last_added: new Date().toISOString(),
    });
  }
}

export async function clearCheckedItems(items: ShoppingItem[]) {
  const checkedItems = items.filter((item) => item.checked);
  if (checkedItems.length === 0) return;

  // Record shopping trip
  await pb().collection("shopping_trips").create({
    list: currentListId,
    completed_at: new Date().toISOString(),
    items: checkedItems.map((item) => ({
      ingredient: item.ingredient,
      ...(item.note ? { note: item.note } : {}),
      categoryId: item.categoryId,
    })),
  });

  // Delete checked items
  await Promise.all(
    checkedItems.map((item) => pb().collection("shopping_items").delete(item.id))
  );
}

// ===== User slug operations =====

export async function getUserSlugs(userId: string, opts?: Record<string, unknown>): Promise<Record<string, string>> {
  try {
    const user = await pb().collection("users").getOne(userId, opts);
    return user.shopping_slugs || {};
  } catch {
    return {};
  }
}

export async function setUserSlug(userId: string, slug: string, listId: string, opts?: Record<string, unknown>) {
  const user = await pb().collection("users").getOne(userId, opts);
  const slugs = { ...(user.shopping_slugs || {}), [slug]: listId };
  await pb().collection("users").update(userId, { shopping_slugs: slugs }, opts);

  // Add user to list owners
  try {
    const list = await pb().collection("shopping_lists").getOne(listId);
    const owners = Array.isArray(list.owners) ? list.owners : [list.owners];
    if (!owners.includes(userId)) {
      await pb().collection("shopping_lists").update(listId, {
        owners: [...owners, userId],
      });
    }
  } catch {
    // List may not exist yet
  }
}

export async function removeUserSlug(userId: string, slug: string) {
  const user = await pb().collection("users").getOne(userId);
  const slugs = { ...(user.shopping_slugs || {}) };
  delete slugs[slug];
  await pb().collection("users").update(userId, { shopping_slugs: slugs });
}

export async function renameUserSlug(userId: string, oldSlug: string, newSlug: string) {
  const user = await pb().collection("users").getOne(userId);
  const slugs = { ...(user.shopping_slugs || {}) };
  if (slugs[oldSlug]) {
    slugs[newSlug] = slugs[oldSlug];
    delete slugs[oldSlug];
    await pb().collection("users").update(userId, { shopping_slugs: slugs });
  }
}

// Re-export for compatibility with old import paths
export function getListRef() { return currentListId; }
export function getUserRef(userId: string) { return userId; }
