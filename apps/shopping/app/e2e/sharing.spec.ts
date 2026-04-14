import { test, expect, signInAsUser2 } from "./fixtures";

/**
 * These tests require the Hono API service running alongside PocketBase.
 * The join flow calls /fn/sharing/list-info which needs the API service.
 *
 * Start: docker compose -f docker-compose.test.yml up -d
 * Then:  cd services/api && PORT=3001 PB_URL=http://127.0.0.1:8091 npx tsx src/index.ts
 */

/** Create a list using the same helper as the main shopping tests */
async function createList(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("button", { name: /New List/ }).click();
  await expect(page.getByText("Create New List")).toBeVisible();
  await page.locator(".ant-modal input").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("combobox")).toBeVisible({ timeout: 10000 });
}

test.describe("List sharing", () => {
  test("user A creates a list, user B joins via share link", async ({ authedPage: page, context }) => {
    // User A creates a list with a unique name
    const listName = `Share Test ${Date.now()}`;
    await createList(page, listName);

    // Open the share modal and grab the join URL
    await page.getByRole("button", { name: /share/i }).first().click();
    const shareInput = page.getByRole("dialog").getByRole("textbox");
    await expect(shareInput).toBeVisible({ timeout: 5000 });
    const joinUrl = await shareInput.inputValue();
    expect(joinUrl).toContain("/join/");

    // Close the modal
    await page.keyboard.press("Escape");

    // Open a separate browser context for user B (clean session)
    const context2 = await page.context().browser()!.newContext();
    const page2 = await context2.newPage();
    await page2.goto("http://localhost:5173/?pick=true");
    await signInAsUser2(page2);
    await expect(page2.getByText("My Lists")).toBeVisible({ timeout: 10000 });

    // Now navigate to the join URL
    await page2.goto(joinUrl);
    await expect(page2.getByText(listName)).toBeVisible({ timeout: 10000 });

    // Click join button
    await page2.getByRole("button", { name: /Add to My Lists/i }).click();

    // Should navigate to the list view (combobox for adding items appears)
    await expect(page2.getByRole("combobox")).toBeVisible({ timeout: 10000 });
  });
});
