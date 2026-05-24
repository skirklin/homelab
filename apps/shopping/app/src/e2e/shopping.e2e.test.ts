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
import { wrapPocketBase } from "@homelab/backend/wrapped-pb";
import type { ShoppingItem, ShoppingTrip } from "@homelab/backend";
import { UNCATEGORIZED_CATEGORY_ID } from "../types";
import { deriveSuggestions } from "../suggestions";

let ctx: TestContext;
let shopping: PocketBaseShoppingBackend;
let userBackend: PocketBaseUserBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  const pb = () => ctx.userPb;
  const wpb = wrapPocketBase(pb);
  shopping = new PocketBaseShoppingBackend(pb, wpb);
  userBackend = new PocketBaseUserBackend(pb, wpb);
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

    await shopping.addItem(listId, "Milk", user.id, UNCATEGORIZED_CATEGORY_ID);

    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(items).toHaveLength(1);
    expect(items[0].ingredient).toBe("Milk");
    expect(items[0].added_by).toBe(user.id);
    expect(items[0].checked).toBe(false);
  });

  it("toggleItem checks and unchecks an item", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Toggle Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "toggle", listId);

    await shopping.addItem(listId, "Eggs", user.id, UNCATEGORIZED_CATEGORY_ID);
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

    await shopping.addItem(listId, "Milk", user.id, UNCATEGORIZED_CATEGORY_ID, "whole");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });

    await shopping.updateItem(items[0].id, { ingredient: "Oat Milk", note: "unsweetened" });

    const updated = await ctx.pb.collection("shopping_items").getOne(items[0].id);
    expect(updated.ingredient).toBe("Oat Milk");
    expect(updated.note).toBe("unsweetened");
  });

  it("updateItemCategory updates the item's category", async () => {
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
  });

  it("clearCheckedItems records a trip and deletes checked items", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Clear Test", user.id);
    await userBackend.setSlug(user.id, "shopping", "clear", listId);

    await shopping.addItem(listId, "Bread", user.id, UNCATEGORIZED_CATEGORY_ID);
    await shopping.addItem(listId, "Butter", user.id, UNCATEGORIZED_CATEGORY_ID);

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
      categoryId: item.category_id || UNCATEGORIZED_CATEGORY_ID,
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

describe("Trip-derived suggestions", () => {
  /**
   * Helper: load all trips for a list and map them to the domain shape that
   * `deriveSuggestions` expects. Mirrors what `subscribeToList` delivers to
   * the UI, but synchronous-ish so tests don't have to spin up a subscription.
   */
  async function loadTrips(listId: string): Promise<ShoppingTrip[]> {
    const records = await ctx.pb.collection("shopping_trips").getFullList({
      filter: `list = "${listId}"`,
      sort: "-completed_at",
    });
    return records.map((r) => ({
      id: r.id,
      list: r.list,
      completedAt: new Date(r.completed_at),
      items: (r.items || []).map((item: { ingredient?: string; name?: string; note?: string; categoryId?: string }) => ({
        ingredient: item.ingredient || item.name || "",
        note: item.note || "",
        categoryId: item.categoryId || UNCATEGORIZED_CATEGORY_ID,
      })),
    }));
  }

  it("ingredient appears in suggestions after a trip is completed; rename surfaces the new name", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Suggestions From Trips", user.id);
    await userBackend.setSlug(user.id, "shopping", "sugg", listId);

    // Add an item, check it, complete the trip — exactly what the UI does.
    await shopping.addItem(listId, "Parsely", user.id, "produce");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    const checkedItems: ShoppingItem[] = items.map((item) => ({
      id: item.id,
      list: item.list,
      ingredient: item.ingredient,
      note: item.note || "",
      categoryId: item.category_id || UNCATEGORIZED_CATEGORY_ID,
      checked: true, // simulate the user checking the row before "Done"
      addedBy: item.added_by,
      addedAt: item.created,
      created: item.created,
      updated: item.updated,
    }));
    await shopping.clearCheckedItems(listId, checkedItems);

    // Suggestion is derived from the trip — the misspelled name shows up.
    let suggestions = deriveSuggestions(await loadTrips(listId));
    expect(suggestions.has("parsely")).toBe(true);
    expect(suggestions.get("parsely")?.categoryId).toBe("produce");
    expect(suggestions.has("parsley")).toBe(false);

    // Find the trip and rename the item in place. After the rename, the new
    // name appears in suggestions and the old one is gone.
    const trips = await ctx.pb.collection("shopping_trips").getFullList({
      filter: `list = "${listId}"`,
    });
    expect(trips).toHaveLength(1);
    await shopping.updateTripItem(trips[0].id, 0, { ingredient: "Parsley" });

    suggestions = deriveSuggestions(await loadTrips(listId));
    expect(suggestions.has("parsley")).toBe(true);
    expect(suggestions.get("parsley")?.ingredient).toBe("Parsley");
    expect(suggestions.has("parsely")).toBe(false);
    // Category carries over.
    expect(suggestions.get("parsley")?.categoryId).toBe("produce");
  });

  it("removeTripItem drops the suggestion derived from that trip item", async () => {
    const user = await createTestUser(ctx);
    const listId = await shopping.createList("Remove Trip Item", user.id);
    await userBackend.setSlug(user.id, "shopping", "remove-trip-item", listId);

    await shopping.addItem(listId, "Basil", user.id, "produce");
    const items = await ctx.pb.collection("shopping_items").getFullList({
      filter: `list = "${listId}"`,
    });
    await shopping.clearCheckedItems(listId, items.map((item) => ({
      id: item.id,
      list: item.list,
      ingredient: item.ingredient,
      note: item.note || "",
      categoryId: item.category_id || UNCATEGORIZED_CATEGORY_ID,
      checked: true,
      addedBy: item.added_by,
      addedAt: item.created,
      created: item.created,
      updated: item.updated,
    })));

    const trips = await ctx.pb.collection("shopping_trips").getFullList({
      filter: `list = "${listId}"`,
    });
    await shopping.removeTripItem(trips[0].id, 0);

    const suggestions = deriveSuggestions(await loadTrips(listId));
    expect(suggestions.has("basil")).toBe(false);
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
