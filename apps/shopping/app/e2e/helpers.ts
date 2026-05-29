/**
 * Shared Playwright helpers for the shopping app.
 *
 * Every list name is suffixed with a per-process RUN_ID. globalSetup
 * (`setupTestEnv`) wipes shopping collections AND clears `shopping_slugs`
 * before each run, but that wipe has been observed to silently no-op under
 * deploy.sh's gate load (e.g. `clearUserFields` swallows admin-auth errors),
 * letting a stale `shopping_slugs["share-test"] -> deleted-listId` survive
 * into the next run — at which point `ListPicker.handleCreateList` refuses
 * to create a duplicate, the share modal hands out a join URL for the
 * already-deleted list, and `sharing.spec.ts` fails with
 * `getByText('Share Test')` invisible on page B. Per-run suffixes make this
 * unreachable: a fresh RUN_ID never collides with any prior run's slug.
 *
 * The unique-name approach is also robust to in-run concurrency (workers:1
 * today, but cheap insurance).
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Per-process suffix so re-running an isolated spec doesn't collide
 *  with leftover slugs from a prior run. Kept legible by combining with
 *  the caller-supplied label in failure screenshots. */
export const RUN_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Build a unique-per-run list name from a stable test-readable label. */
export function uniqueListName(label: string): string {
  return `${label} ${RUN_ID}`;
}

/** The add-item ingredient input is an Ant Design AutoComplete, which
 *  exposes the inner element as role=combobox. */
export const itemInput = (page: Page) => page.getByRole("combobox");

/**
 * Click "New List", fill the create modal, and wait for the list view.
 * The supplied `label` is wrapped with a per-run suffix so multiple test
 * runs against the same PB don't fight for the same slug — see file header
 * for why the globalSetup wipe is not sufficient.
 */
export async function createList(page: Page, label: string): Promise<string> {
  const name = uniqueListName(label);
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
