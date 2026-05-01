/**
 * Playwright tests for the optimistic-write wrapper UX.
 *
 * Each test slows down PocketBase writes via route mocking so the gap between
 * "user clicks button" and "network confirms" is wide enough to assert
 * within. Without the wrapper, the UI would sit blocked for the full network
 * delay; with the wrapper, the UI updates synchronously and reconciles when
 * the network response arrives.
 */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const itemInput = (page: Page) => page.getByRole("combobox");

async function createList(page: Page, name: string) {
  await page.getByRole("button", { name: /New List/ }).click();
  await expect(page.getByText("Create New List")).toBeVisible();
  const input = page.locator(".ant-modal input");
  await input.fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(itemInput(page)).toBeVisible({ timeout: 10000 });
}

async function fillAddItemForm(page: Page, ingredient: string) {
  const input = itemInput(page);
  await input.click();
  await input.clear();
  await input.pressSequentially(ingredient);
  await expect(input).toHaveValue(ingredient, { timeout: 2000 });
  // Click the Note field to dismiss the autocomplete dropdown.
  await page.getByRole("textbox", { name: "Note" }).click();
}

// Per-run suffix so slugs don't collide with leftovers from prior runs.
const RUN = Date.now().toString(36);

test.describe("Optimistic writes", () => {
  test("add item appears in the UI before the network create completes", async ({ authedPage: page }) => {
    await createList(page, `Slow-Net Add ${RUN}`);

    // Hold the create POST for 2s before letting it through.
    await page.route("**/api/collections/shopping_items/records", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    await fillAddItemForm(page, "Milk");
    const startedAt = Date.now();
    await page.getByRole("button", { name: /Add/ }).click();

    // Optimistic: should be visible well under the 2s network throttle.
    await expect(page.getByText("Milk")).toBeVisible({ timeout: 500 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(800);
  });

  test("delete item disappears from the UI before the network delete completes", async ({ authedPage: page }) => {
    await createList(page, `Slow-Net Delete ${RUN}`);
    // Add normally first.
    await fillAddItemForm(page, "Bread");
    await page.getByRole("button", { name: /Add/ }).click();
    await expect(page.getByText("Bread")).toBeVisible({ timeout: 5000 });

    // Hold the next delete for 2s.
    await page.route("**/api/collections/shopping_items/records/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    const startedAt = Date.now();
    await page.locator("[aria-label='delete']").first().click();

    // Optimistic: gone from UI well before the 2s network completes.
    await expect(page.getByText("Bread")).not.toBeVisible({ timeout: 500 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(800);
  });

  test("rejected create rolls back the optimistic UI", async ({ authedPage: page }) => {
    await createList(page, `Rollback ${RUN}`);

    // Stub the next create POST to return 403 after a brief delay so the
    // optimistic state is observable before rollback.
    await page.route("**/api/collections/shopping_items/records", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 600));
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "forbidden", code: 403 }),
        });
        return;
      }
      await route.continue();
    });

    await fillAddItemForm(page, "Forbidden");
    await page.getByRole("button", { name: /Add/ }).click();

    // Optimistic appearance.
    await expect(page.getByText("Forbidden")).toBeVisible({ timeout: 500 });

    // After the 403 lands, the wrapper drops the pending mutation and the UI
    // reverts. Give it 3s to cover the 600ms delay + rollback propagation.
    await expect(page.getByText("Forbidden")).not.toBeVisible({ timeout: 3000 });
  });
});
