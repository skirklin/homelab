import { test, expect, type Page, type BrowserContext } from "@playwright/test";

test.setTimeout(60000);

/**
 * Create a fresh browser context and sign up a new user.
 * Standalone recipes app uses antd Form inputs (no data-testid).
 */
async function newSignedInPage(browser: { newContext: () => Promise<BrowserContext> }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/");
  await expect(page.getByText("Recipe Book")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: /Don't have an account/i }).click();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("testpassword123");
  await page.getByRole("button", { name: /sign up/i }).click();
  await expect(page.getByText("All Recipes")).toBeVisible({ timeout: 10000 });

  await dismissModals(page);
  await expect(page.locator('.ant-spin-spinning')).not.toBeVisible({ timeout: 10000 });

  return { page, context };
}

async function dismissModals(page: Page) {
  // Wait for delayed popovers (cooking mode has a 1s setTimeout)
  await page.waitForTimeout(1500);
  // Click all "Got it" buttons via JS to bypass viewport/overlay checks
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(btn => {
      if (btn.textContent?.trim().match(/^Got it/i)) {
        btn.click();
      }
    });
  });
  await page.waitForTimeout(500);
}

async function navigateToBoxes(page: Page) {
  await dismissModals(page);
  const boxesButton = page.locator('button').filter({ has: page.locator('.anticon-inbox') }).first();
  await boxesButton.click();
  await expect(page).toHaveURL(/\/boxes$/);
  await expect(page.locator('.ant-spin-spinning')).not.toBeVisible({ timeout: 10000 });
  await dismissModals(page);
}

async function createBox(page: Page, name: string) {
  await dismissModals(page);
  await page.getByTitle("Create new box.").click();
  const modal = page.getByRole("dialog").filter({ hasText: "OK" });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.locator('input').fill(name);
  await modal.getByRole("button", { name: /ok/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 5000 });
}

test.describe("Recipe Box Sharing (Standalone App)", () => {
  test("User A creates a box, User B joins via link, box is visible", async ({ browser }) => {
    const boxName = `Shared Standalone ${Date.now()}`;

    // --- User A: Create box ---
    const { page: pageA, context: ctxA } = await newSignedInPage(browser);
    await navigateToBoxes(pageA);
    await expect(pageA.getByText("Your Boxes")).toBeVisible({ timeout: 10000 });
    await createBox(pageA, boxName);
    await expect(pageA.getByText(boxName)).toBeVisible({ timeout: 5000 });

    // Navigate into box and extract boxId
    await pageA.getByText(boxName).click();
    await expect(pageA).toHaveURL(/\/boxes\//);
    const boxId = pageA.url().match(/\/boxes\/([^/]+)/)![1];
    await ctxA.close();

    // --- User B: Join via link ---
    const { page: pageB, context: ctxB } = await newSignedInPage(browser);
    await pageB.goto(`/join/${boxId}`);
    await expect(pageB.getByText(boxName)).toBeVisible({ timeout: 10000 });
    await pageB.getByRole("button", { name: /add to my boxes/i }).click();

    // JoinBox should navigate to /boxes/{id} after successful join
    await expect(pageB).toHaveURL(/\/boxes\//, { timeout: 10000 });

    // Navigate to boxes list and verify the shared box appears
    await navigateToBoxes(pageB);
    await dismissModals(pageB);
    await expect(pageB.getByText("Your Boxes")).toBeVisible({ timeout: 15000 });
    // Wait for Firestore subscriptions to load the box list
    await expect(pageB.getByText(boxName)).toBeVisible({ timeout: 15000 });
    await ctxB.close();
  });

  test("boxes page links don't double up /boxes/boxes/", async ({ browser }) => {
    const boxName = `NavStandalone ${Date.now()}`;

    const { page, context } = await newSignedInPage(browser);
    await navigateToBoxes(page);
    await expect(page.getByText("Your Boxes")).toBeVisible({ timeout: 10000 });
    await createBox(page, boxName);
    await expect(page.getByText(boxName)).toBeVisible({ timeout: 5000 });

    // Click box — URL should be /boxes/{id}, NOT /boxes/boxes/{id}
    await page.getByText(boxName).click();
    await expect(page).toHaveURL(/\/boxes\/[^/]+$/);
    expect(page.url()).not.toContain("/boxes/boxes/");
    await context.close();
  });
});
