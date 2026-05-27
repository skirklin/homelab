import { test, expect } from "./fixtures";
import { addItem, createList, itemInput } from "./helpers";

test.describe("Shopping app", () => {
  test("sign in and see list picker", async ({ authedPage: page }) => {
    await expect(page.getByText("My Lists")).toBeVisible();
    await expect(page.getByRole("button", { name: /New List/ })).toBeVisible();
  });

  test("create a new shopping list", async ({ authedPage: page }) => {
    await createList(page, "Weekly Groceries");
    await expect(itemInput(page)).toBeVisible();
  });

  test("add items to a list", async ({ authedPage: page }) => {
    await createList(page, "Test Items List");

    await addItem(page, "Milk");
    await addItem(page, "Bread", "whole wheat");

    await expect(page.getByText("Milk")).toBeVisible();
    await expect(page.getByText("Bread")).toBeVisible();
    await expect(page.getByText("(whole wheat)")).toBeVisible();
  });

  test("check and uncheck an item", async ({ authedPage: page }) => {
    await createList(page, "Check Test");
    await addItem(page, "Eggs");

    // Check the item by clicking the Ant Design checkbox wrapper
    const checkbox = page.locator(".ant-checkbox").first();
    await checkbox.click();

    // The "Done" button should appear with count
    await expect(page.getByRole("button", { name: /Done \(1\)/ })).toBeVisible({ timeout: 5000 });

    // Uncheck the item
    await checkbox.click();

    // "Done" button should disappear
    await expect(page.getByRole("button", { name: /Done \(1\)/ })).not.toBeVisible({ timeout: 5000 });
  });

  test("delete an item", async ({ authedPage: page }) => {
    await createList(page, "Delete Test");
    await addItem(page, "Butter");

    // Click the delete button (trash icon)
    await page.locator("[aria-label='delete']").first().click();

    // Item should disappear
    await expect(page.getByText("Butter")).not.toBeVisible({ timeout: 5000 });
  });

  test("done shopping clears checked items", async ({ authedPage: page }) => {
    await createList(page, "Done Flow Test");
    await addItem(page, "Apples");
    await addItem(page, "Bananas");
    await addItem(page, "Cherries");

    // Check two items
    const checkboxes = page.locator(".ant-checkbox");
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();

    // "Done (2)" button should appear
    const doneButton = page.getByRole("button", { name: /Done \(2\)/ });
    await expect(doneButton).toBeVisible({ timeout: 5000 });

    // Click Done
    await doneButton.click();

    // The two checked items should be cleared, one unchecked item remains
    await expect(page.getByRole("button", { name: /Done/ })).not.toBeVisible({ timeout: 5000 });
    // At least one item should remain (Cherries was not checked)
    await expect(page.getByText("Cherries")).toBeVisible();
  });

  test("edit an item inline", async ({ authedPage: page }) => {
    await createList(page, "Edit Test");
    await addItem(page, "Tomatos");

    // Click the item name to enter edit mode
    await page.getByText("Tomatos").click();

    // Edit the ingredient - find the input that currently has "Tomatos"
    const editInput = page.locator("input[placeholder='Ingredient']");
    await expect(editInput).toBeVisible({ timeout: 3000 });
    await editInput.clear();
    await editInput.fill("Tomatoes");

    // Save the edit by clicking the check icon
    await page.locator("[aria-label='check']").first().click();

    // The updated name should be visible
    await expect(page.getByText("Tomatoes")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Tomatos")).not.toBeVisible();
  });

  test("duplicate item is rejected", async ({ authedPage: page }) => {
    await createList(page, "Dupe Test");
    await addItem(page, "Milk");

    // Try adding the same item again — the form's duplicate-guard surfaces
    // an Ant Design message.warning ("...is already on the list") instead
    // of going through the network. The first item stays visible and no
    // second row appears.
    await itemInput(page).fill("Milk");
    await page.getByRole("button", { name: /Add/ }).click();

    // The warning toast should appear and we should still only have one row.
    await expect(page.getByText(/is already on the list/i)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".ant-checkbox")).toHaveCount(1);
  });

  test("navigate back to list picker", async ({ authedPage: page }) => {
    const name = await createList(page, "Nav Test");

    // Click back button
    await page.locator("[aria-label='arrow-left']").click();

    // Should be back at list picker with the list we created
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).toBeVisible();
  });
});
