/**
 * Integration tests for the shopping app using the @homelab/backend interface.
 * Tests the PocketBase backend implementations against a real PocketBase instance.
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
import { PocketBaseShoppingBackend, PocketBaseUserBackend } from "@homelab/backend/pocketbase";
import type { ShoppingItem } from "@homelab/backend";

let ctx: TestContext;
let shopping: PocketBaseShoppingBackend;
let userBackend: PocketBaseUserBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  shopping = new PocketBaseShoppingBackend(() => ctx.userPb);
  userBackend = new PocketBaseUserBackend(() => ctx.userPb);
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

describe("List operations", () => {
  it("createList creates a list and sets the user slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Weekly Shop", user.id);
    expect(listId).toBeTruthy();

    await userBackend.setSlug(user.id, "shopping", "weekly", listId);

    const list = await shopping.getList(listId);
    expect(list).not.toBeNull();
    expect(list!.name).toBe("Weekly Shop");

    const slugs = await userBackend.getSlugs(user.id, "shopping");
    expect(slugs.weekly).toBe(listId);
  });

  it("renameList updates the name", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Old Name", user.id);
    await userBackend.setSlug(user.id, "shopping", "rename-test", listId);

    await shopping.renameList(listId, "New Name");

    const list = await shopping.getList(listId);
    expect(list!.name).toBe("New Name");
  });

  it("deleteList removes the list", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("To Delete", user.id);
    await userBackend.setSlug(user.id, "shopping", "delete-test", listId);

    await shopping.deleteList(listId);

    const list = await shopping.getList(listId);
    expect(list).toBeNull();
  });

  it("getListById returns null for non-existent list", async () => {
    await createTestUser(ctx);
    const list = await shopping.getList("nonexistent_id_12345");
    expect(list).toBeNull();
  });
});

describe("Item operations", () => {
  it("addItem creates an item on the list", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Item Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "items", listId);

    await shopping.addItem(listId, "Milk", user.id, "uncategorized");

    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(items).toHaveLength(1);
    expect(items[0].ingredient).toBe("Milk");
    expect(items[0].added_by).toBe(user.id);
    expect(items[0].checked).toBe(false);
  });

  it("addItem upserts history with the supplied category", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("History Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "history", listId);

    await shopping.addItem(listId, "Cheese", user.id, "dairy");

    const history = await ctx.pb.collection("shopping_history").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(history).toHaveLength(1);
    expect(history[0].ingredient).toBe("cheese"); // normalized to lowercase
    expect(history[0].category_id).toBe("dairy");

    // Re-adding with a different category updates the existing history row.
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    await shopping.deleteItem(items[0].id);
    await shopping.addItem(listId, "Cheese", user.id, "snacks");

    const updatedHistory = await ctx.pb.collection("shopping_history").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(updatedHistory).toHaveLength(1);
    expect(updatedHistory[0].category_id).toBe("snacks");
  });

  it("toggleItem checks and unchecks an item", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Toggle Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "toggle", listId);

    await shopping.addItem(listId, "Eggs", user.id, "uncategorized");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    // Toggle on
    await shopping.toggleItem(items[0].id, true, user.id);
    const checked = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(checked.checked).toBe(true);
    expect(checked.checked_by).toBe(user.id);

    // Toggle off
    await shopping.toggleItem(items[0].id, false, user.id);
    const unchecked = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(unchecked.checked).toBe(false);
  });

  it("updateItem updates ingredient and note", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Update Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "update", listId);

    await shopping.addItem(listId, "Milk", user.id, "uncategorized", "whole");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    await shopping.updateItem(items[0].id, { ingredient: "Oat Milk", note: "unsweetened" });

    const updated = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(updated.ingredient).toBe("Oat Milk");
    expect(updated.note).toBe("unsweetened");
  });

  it("updateItemCategory updates the item and history", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Category Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "cat", listId);

    await shopping.addItem(listId, "Apples", user.id, "produce");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    await shopping.updateItemCategory(items[0].id, listId, "fruit", items[0].ingredient);

    const updated = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(updated.category_id).toBe("fruit");

    const history = await ctx.pb.collection("shopping_history").getFirstListItem(
      `list = "${listId}" && ingredient = "apples"`
    );
    expect(history.category_id).toBe("fruit");
  });

  it("clearCheckedItems records a trip and deletes checked items", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Clear Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "clear", listId);

    await shopping.addItem(listId, "Bread", user.id, "uncategorized");
    await shopping.addItem(listId, "Butter", user.id, "uncategorized");

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

    // Reload with checked state and map to ShoppingItem
    const checkedItems: ShoppingItem[] = (
      await ctx.pb.collection("shopping_items").getFullList({
        filter: `list = "${listId}"`,
      })
    ).map((item) => ({
      id: item.id,
      list: item.list,
      ingredient: item.ingredient,
      note: item.note || "",
      categoryId: item.category_id || "uncategorized",
      checked: item.checked,
      addedBy: item.added_by,
    }));

    await shopping.clearCheckedItems(listId, checkedItems);

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
    const listId = await shopping.createList("Cat Defs", user.id);
    await userBackend.setSlug(user.id, "shopping", "catdefs", listId);

    await shopping.updateCategories(listId, [
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
    const listId = await shopping.createList("Slug Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "slug-test", listId);

    const slugs = await userBackend.getSlugs(user.id, "shopping");
    expect(slugs["slug-test"]).toBeTruthy();
  });

  it("removeUserSlug removes a slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Remove Slug", user.id);
    await userBackend.setSlug(user.id, "shopping", "to-remove", listId);

    await userBackend.removeSlug(user.id, "shopping", "to-remove");

    const slugs = await userBackend.getSlugs(user.id, "shopping");
    expect(slugs["to-remove"]).toBeUndefined();
  });

  it("renameUserSlug renames a slug", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Rename Slug", user.id);
    await userBackend.setSlug(user.id, "shopping", "old-name", listId);

    await userBackend.renameSlug(user.id, "shopping", "old-name", "new-name");

    const slugs = await userBackend.getSlugs(user.id, "shopping");
    expect(slugs["old-name"]).toBeUndefined();
    expect(slugs["new-name"]).toBe(listId);
  });

  it("joining a list: owner adds user2, then user2 sets their slug", async () => {
    const user1 = await createTestUser(ctx);
    const listId = await shopping.createList("Shared List", user1.id);
    await userBackend.setSlug(user1.id, "shopping", "shared", listId);

    // Owner (user1) adds user2 to the list via admin client (simulating join endpoint)
    const user2 = await createUserWithoutSignIn(ctx);
    const list = await ctx.pb.collection("shopping_lists").getOne(listId);
    await ctx.pb.collection("shopping_lists").update(listId, {
      owners: [...list.owners, user2.id],
    });

    // User2 signs in and sets their own slug
    await signInAsUser(ctx, user2);
    await userBackend.setSlug(user2.id, "shopping", "my-list", listId);

    const slugs = await userBackend.getSlugs(user2.id, "shopping");
    expect(slugs["my-list"]).toBe(listId);

    // Both users are owners
    const updated = await ctx.pb.collection("shopping_lists").getOne(listId);
    expect(updated.owners).toContain(user1.id);
    expect(updated.owners).toContain(user2.id);
  });
});
