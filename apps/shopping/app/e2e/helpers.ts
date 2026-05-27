/**
 * Shared Playwright helpers for the shopping app.
 *
 * The test PB instance accumulates data across runs (no teardown). Tests
 * that hard-code list names collide on the second run because the slug
 * already exists in the user's slug map and ListPicker.handleCreateList
 * silently refuses to create a duplicate. Every list name passed through
 * `createList` is suffixed with a per-process run id so re-running an
 * isolated spec stays green without manual PB wipes.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Per-process suffix so re-running an isolated spec doesn't collide
 *  with leftover lists from a prior run. Combine with the caller-supplied
 *  name to keep test intent legible in failure screenshots. */
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
 * runs against the same PB don't fight for the same slug.
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
