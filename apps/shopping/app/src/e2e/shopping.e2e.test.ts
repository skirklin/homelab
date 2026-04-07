/**
 * Integration tests for the shopping app's pocketbase.ts functions.
 * Tests the actual app code against a real PocketBase instance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  cleanupTestPocketBase,
  createTestUser,
  createUserWithoutSignIn,
  signInAsUser,
  type TestContext,
} from "@kirkl/shared/test-utils";
import {
  createList,
  renameList,
  deleteList,
  getListById,
  setCurrentListId,
  addItem,
  toggleItem,
  deleteItem,
  updateItem,
  updateItemCategory,
  clearCheckedItems,
  updateCategories,
  getUserSlugs,
  setUserSlug,
  removeUserSlug,
  renameUserSlug,
} from "../pocketbase";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await initTestPocketBase();
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

describe("List operations", () => {
  it("createList creates a list and sets the user slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Weekly Shop", "weekly", user.id);
    expect(listId).toBeTruthy();

    const list = await getListById(listId);
    expect(list).not.toBeNull();
    expect(list!.name).toBe("Weekly Shop");

    const slugs = await getUserSlugs(user.id);
    expect(slugs.weekly).toBe(listId);
  });

  it("renameList updates the name", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Old Name", "rename-test", user.id);

    await renameList(listId, "New Name");

    const list = await getListById(listId);
    expect(list!.name).toBe("New Name");
  });

  it("deleteList removes the list", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("To Delete", "delete-test", user.id);

    await deleteList(listId);

    const list = await getListById(listId);
    expect(list).toBeNull();
  });

  it("getListById returns null for non-existent list", async () => {
    await createTestUser(ctx);
    const list = await getListById("nonexistent_id_12345");
    expect(list).toBeNull();
  });
});

describe("Item operations", () => {
  it("addItem creates an item on the current list", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Item Test", "items", user.id);
    setCurrentListId(listId);

    await addItem("Milk", user.id);

    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(items).toHaveLength(1);
    expect(items[0].ingredient).toBe("Milk");
    expect(items[0].added_by).toBe(user.id);
    expect(items[0].checked).toBe(false);
  });

  it("addItem saves history and reuses category from history", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("History Test", "history", user.id);
    setCurrentListId(listId);

    // First add with explicit category
    await addItem("Cheese", user.id, { categoryId: "dairy" });

    // Check history was created
    const history = await ctx.pb.collection("shopping_history").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(history).toHaveLength(1);
    expect(history[0].ingredient).toBe("cheese"); // normalized to lowercase
    expect(history[0].category_id).toBe("dairy");

    // Delete the item, then re-add without category — should pick up "dairy" from history
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    await deleteItem(items[0].id);

    await addItem("Cheese", user.id);

    const newItems = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(newItems[0].category_id).toBe("dairy");
  });

  it("toggleItem checks and unchecks an item", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Toggle Test", "toggle", user.id);
    setCurrentListId(listId);

    await addItem("Eggs", user.id);
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    const shoppingItem = {
      id: items[0].id,
      ingredient: items[0].ingredient,
      categoryId: items[0].category_id,
      checked: false,
      addedBy: items[0].added_by,
      addedAt: new Date(items[0].created),
    };

    // Toggle on
    await toggleItem(shoppingItem, user.id);
    const checked = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(checked.checked).toBe(true);
    expect(checked.checked_by).toBe(user.id);

    // Toggle off
    await toggleItem({ ...shoppingItem, checked: true }, user.id);
    const unchecked = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(unchecked.checked).toBe(false);
  });

  it("updateItem updates ingredient and note", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Update Test", "update", user.id);
    setCurrentListId(listId);

    await addItem("Milk", user.id, { note: "whole" });
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    await updateItem(items[0].id, { ingredient: "Oat Milk", note: "unsweetened" });

    const updated = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(updated.ingredient).toBe("Oat Milk");
    expect(updated.note).toBe("unsweetened");
  });

  it("updateItemCategory updates the item and history", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Category Test", "cat", user.id);
    setCurrentListId(listId);

    await addItem("Apples", user.id, { categoryId: "produce" });
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    const shoppingItem = {
      id: items[0].id,
      ingredient: items[0].ingredient,
      categoryId: items[0].category_id,
      checked: false,
      addedBy: user.id,
      addedAt: new Date(),
    };

    await updateItemCategory(shoppingItem, "fruit");

    const updated = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(updated.category_id).toBe("fruit");

    const history = await ctx.pb.collection("shopping_history").getFirstListItem(
      `list = "${listId}" && ingredient = "apples"`
    );
    expect(history.category_id).toBe("fruit");
  });

  it("clearCheckedItems records a trip and deletes checked items", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Clear Test", "clear", user.id);
    setCurrentListId(listId);

    await addItem("Bread", user.id);
    await addItem("Butter", user.id);

    // Check both items
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    for (const item of items) {
      await ctx.pb.collection("shopping_items").update(item.id, {
        checked: true,
        checked_by: user.id,
      });
    }

    // Reload with checked state
    const checkedItems = (
      await ctx.pb.collection("shopping_items").getFullList({
        filter: `list = "${listId}"`,
      })
    ).map((item) => ({
      id: item.id,
      ingredient: item.ingredient,
      categoryId: item.category_id,
      checked: item.checked,
      addedBy: item.added_by,
      addedAt: new Date(item.created),
    }));

    await clearCheckedItems(checkedItems);

    const remaining = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(remaining).toHaveLength(0);

    const trips = await ctx.pb.collection("shopping_trips").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(trips).toHaveLength(1);
    expect(trips[0].items).toHaveLength(2);
  });
});

describe("Category operations", () => {
  it("updateCategories sets category definitions on the list", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Cat Defs", "catdefs", user.id);
    setCurrentListId(listId);

    await updateCategories([
      { id: "produce", name: "Produce" },
      { id: "dairy", name: "Dairy" },
    ]);

    const list = await ctx.pb.collection("shopping_lists").getOne(listId);
    expect(list.category_defs).toHaveLength(2);
    expect(list.category_defs[0].id).toBe("produce");
  });
});

describe("User slug operations", () => {
  it("setUserSlug and getUserSlugs round-trip", async () => {
    const user = await createTestUser(ctx);
    await createList("Slug Test", "slug-test", user.id);

    const slugs = await getUserSlugs(user.id);
    expect(slugs["slug-test"]).toBeTruthy();
  });

  it("removeUserSlug removes a slug", async () => {
    const user = await createTestUser(ctx);
    await createList("Remove Slug", "to-remove", user.id);

    await removeUserSlug(user.id, "to-remove");

    const slugs = await getUserSlugs(user.id);
    expect(slugs["to-remove"]).toBeUndefined();
  });

  it("renameUserSlug renames a slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await createList("Rename Slug", "old-name", user.id);

    await renameUserSlug(user.id, "old-name", "new-name");

    const slugs = await getUserSlugs(user.id);
    expect(slugs["old-name"]).toBeUndefined();
    expect(slugs["new-name"]).toBe(listId);
  });

  it("joining a list: owner adds user2, then user2 sets their slug", async () => {
    const user1 = await createTestUser(ctx);
    const listId = await createList("Shared List", "shared", user1.id);

    // Owner (user1) adds user2 to the list via admin client (simulating join endpoint)
    const user2 = await createUserWithoutSignIn(ctx);
    const list = await ctx.pb.collection("shopping_lists").getOne(listId);
    await ctx.pb.collection("shopping_lists").update(listId, {
      owners: [...list.owners, user2.id],
    });

    // User2 signs in and sets their own slug
    await signInAsUser(ctx, user2);
    await setUserSlug(user2.id, "my-list", listId);

    const slugs = await getUserSlugs(user2.id);
    expect(slugs["my-list"]).toBe(listId);

    // Both users are owners
    const updated = await ctx.pb.collection("shopping_lists").getOne(listId);
    expect(updated.owners).toContain(user1.id);
    expect(updated.owners).toContain(user2.id);
  });
});
