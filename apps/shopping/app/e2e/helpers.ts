/**
 * Shared Playwright helpers for the shopping app.
 *
 * List names are used verbatim — no per-run suffix. globalSetup
 * (`setupTestEnv`) wipes shopping collections AND clears every user's
 * `shopping_slugs` map before each run, and both wipes are fail-loud:
 * `wipeCollections` and `clearUserFields` in @kirkl/shared/test-utils
 * throw on any non-404 error rather than silently no-op'ing. So a stale
 * `shopping_slugs["share-test"] -> deleted-listId` can't survive a run
 * undetected — either the wipe succeeds (clean slate, stable names safe)
 * or it throws and the gate fails loudly at globalSetup with the actual
 * underlying error.
 *
 * Inside a run, workers:1 means no concurrent list creation, and every
 * spec uses the value `createList` returns rather than re-deriving the
 * name, so a stable label is safe there too.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** The add-item ingredient input is an Ant Design AutoComplete, which
 *  exposes the inner element as role=combobox. */
export const itemInput = (page: Page) => page.getByRole("combobox");

/**
 * Click "New List", fill the create modal with `name`, and wait for the list
 * view. Returns `name` so callers can reference the created list.
 */
export async function createList(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: /New List/ }).click();
  await expect(page.getByText("Create New List")).toBeVisible();
  await page.locator(".ant-modal input").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  // Wait for the list view to load (the add-item combobox appears).
  await expect(itemInput(page)).toBeVisible({ timeout: 10000 });
  return name;
}

/**
 * Add an item via the add-item form (assumes we're on the list view).
 * Uses `pressSequentially` because `.fill()` on Ant's AutoComplete can
 * skip the controlled-state update path that the autocomplete dropdown
 * relies on.
 */
export async function addItem(page: Page, ingredient: string, note?: string) {
  const input = itemInput(page);
  await input.click();
  await input.clear();
  await input.pressSequentially(ingredient);
  await expect(input).toHaveValue(ingredient, { timeout: 2000 });
  if (note) {
    await page.getByRole("textbox", { name: "Note" }).fill(note);
  } else {
    // Click the Note field to dismiss the autocomplete dropdown so the
    // Add button isn't intercepted by it.
    await page.getByRole("textbox", { name: "Note" }).click();
  }
  await page.getByRole("button", { name: /Add/ }).click();
  await expect(page.getByText(ingredient)).toBeVisible({ timeout: 10000 });
}
