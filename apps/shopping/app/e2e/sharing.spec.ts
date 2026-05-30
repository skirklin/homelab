import { test, expect, signInAsUser2 } from "./fixtures";
import { createList, itemInput } from "./helpers";

/**
 * These tests require the Hono API service running alongside PocketBase.
 * The join flow calls /fn/sharing/list-info which needs the API service.
 *
 * Start: docker compose -f docker-compose.test.yml up -d
 * Then:  cd services/api && PORT=3001 PB_URL=http://127.0.0.1:8091 npx tsx src/index.ts
 */

test.describe("List sharing", () => {
  test("user A creates a list, user B joins via share link", async ({ authedPage: page }) => {
    // User A creates a list. globalSetup wipes lists + clears slug maps
    // before each run, and both wipes are fail-loud — see helpers.ts header
    // — so a stable name can't collide with leftovers.
    const listName = await createList(page, "Share Test");

    // Open the share modal and grab the join URL
    await page.getByRole("button", { name: /share/i }).first().click();
    const shareInput = page.getByRole("dialog").getByRole("textbox");
    await expect(shareInput).toBeVisible({ timeout: 5000 });
    const joinUrl = await shareInput.inputValue();
    expect(joinUrl).toContain("/join/");

    // Close the modal
    await page.keyboard.press("Escape");

    // Open a separate browser context for user B (clean session). Derive
    // the dev-server URL from page1 so per-worktree vite ports work — the
    // hardcoded :5173 broke once parallel-worktree port derivation landed.
    const baseURL = new URL(page.url()).origin;
    const context2 = await page.context().browser()!.newContext({ baseURL });
    const page2 = await context2.newPage();
    await page2.goto("/?pick=true");
    await signInAsUser2(page2);
    await expect(page2.getByText("My Lists")).toBeVisible({ timeout: 10000 });

    // Now navigate to the join URL
    await page2.goto(joinUrl);
    await expect(page2.getByText(listName)).toBeVisible({ timeout: 10000 });

    // Click join button
    await page2.getByRole("button", { name: /Add to My Lists/i }).click();

    // Should see the list view with the add-item input
    await expect(itemInput(page2)).toBeVisible({ timeout: 10000 });
  });
});
