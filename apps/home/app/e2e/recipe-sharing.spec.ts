import { test, expect, type Page, type BrowserContext } from "@playwright/test";

test.setTimeout(60000);

/**
 * Create a fresh browser context and sign up a new user.
 * Each call gets a completely isolated session — no shared state.
 */
async function newSignedInPage(browser: { newContext: () => Promise<BrowserContext> }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  await page.goto("/");
  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /Don't have an account/i }).click();
  await emailInput.fill(email);
  await page.getByTestId("password-input").fill("testpassword123");
  await page.getByTestId("email-sign-in").click();
  await expect(page.getByTestId("email-input")).not.toBeVisible({ timeout: 10000 });

  return { page, context };
}

async function dismissModals(page: Page) {
  await page.waitForTimeout(500);
  const whatsNewModal = page.getByRole("dialog", { name: /what's new/i });
  if (await whatsNewModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await whatsNewModal.getByRole("button", { name: /got it/i }).click();
    await expect(whatsNewModal).not.toBeVisible({ timeout: 3000 });
  }
}

async function navigateToRecipes(page: Page) {
  await page.getByRole("button", { name: /recipes/i }).click();
  await expect(page).toHaveURL(/\/recipes/);
  await dismissModals(page);
  await expect(page.getByText("All Recipes")).toBeVisible({ timeout: 15000 });
}

async function navigateToBoxes(page: Page) {
  await dismissModals(page);
  const boxesButton = page.locator('button').filter({ has: page.locator('.anticon-inbox') }).first();
  await boxesButton.click();
  await expect(page).toHaveURL(/\/recipes\/boxes/);
  await expect(page.getByText("Your Boxes")).toBeVisible({ timeout: 15000 });
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

test.describe("Recipe Box Sharing (Home App)", () => {
  test("User A creates a box, shares via invite link, User B redeems", async ({ browser }) => {
    const boxName = `Shared ${Date.now()}`;

    // --- User A: Create box and get invite link ---
    const { page: pageA, context: ctxA } = await newSignedInPage(browser);
    await navigateToRecipes(pageA);
    await navigateToBoxes(pageA);
    await expect(pageA.getByText("Your Boxes")).toBeVisible({ timeout: 10000 });
    await createBox(pageA, boxName);
    await expect(pageA.getByText(boxName)).toBeVisible({ timeout: 5000 });

    // Navigate into the box
    await pageA.getByText(boxName).click();
    await expect(pageA).toHaveURL(/\/recipes\/boxes\//);

    // Click Sharing dropdown, then "Create invite link"
    await pageA.getByRole("button", { name: /sharing/i }).click();
    const inviteItem = pageA.getByText("Create invite link");
    await expect(inviteItem).toBeVisible({ timeout: 5000 });

    // Capture the clipboard content when invite is created
    await pageA.evaluate(() => {
      // Mock clipboard to capture the URL
      (window as unknown as Record<string, unknown>).__clipboardText = "";
      navigator.clipboard.writeText = async (text: string) => {
        (window as unknown as Record<string, unknown>).__clipboardText = text;
      };
    });
    await inviteItem.click();

    // Wait for the invite to be created (toast should appear)
    await expect(pageA.getByText(/invite link copied/i)).toBeVisible({ timeout: 10000 });

    // Get the invite URL from the mocked clipboard
    const inviteUrl = await pageA.evaluate(() =>
      (window as unknown as Record<string, string>).__clipboardText
    );
    expect(inviteUrl).toContain("/invite/");

    // Extract the invite path (relative)
    const invitePath = new URL(inviteUrl).pathname;
    await ctxA.close();

    // --- User B: Redeem invite ---
    const { page: pageB, context: ctxB } = await newSignedInPage(browser);
    await pageB.goto(invitePath);

    // Should see success and redirect to the box
    await expect(pageB.getByText(/invite accepted/i)).toBeVisible({ timeout: 10000 });
    await expect(pageB).toHaveURL(/\/recipes\/boxes\//, { timeout: 10000 });

    // Verify box appears in User B's boxes list
    await navigateToBoxes(pageB);
    await expect(pageB.getByText("Your Boxes")).toBeVisible({ timeout: 10000 });
    await expect(pageB.getByText(boxName)).toBeVisible({ timeout: 15000 });
    await ctxB.close();
  });

  test("boxes page links don't double up /boxes/boxes/", async ({ browser }) => {
    const boxName = `NavTest ${Date.now()}`;

    const { page, context } = await newSignedInPage(browser);
    await navigateToRecipes(page);
    await navigateToBoxes(page);
    await expect(page.getByText("Your Boxes")).toBeVisible({ timeout: 10000 });
    await createBox(page, boxName);
    await expect(page.getByText(boxName)).toBeVisible({ timeout: 5000 });

    // Click box — URL should be /recipes/boxes/{id}, NOT /recipes/boxes/boxes/{id}
    await page.getByText(boxName).click();
    await expect(page).toHaveURL(/\/recipes\/boxes\/[^/]+$/);
    expect(page.url()).not.toContain("/boxes/boxes/");
    await context.close();
  });
});
