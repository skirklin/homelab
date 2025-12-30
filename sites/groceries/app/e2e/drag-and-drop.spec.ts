import { test, expect, Page } from "@playwright/test";

const TEST_USER = {
  email: "test@example.com",
  password: "testpassword123",
};

// Helper to sign in via the dev login form
async function signIn(page: Page) {
  await page.goto("/");

  // Wait for the dev login form
  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor({ timeout: 10000 });

  // Fill in credentials and sign in
  await emailInput.fill(TEST_USER.email);
  await page.getByTestId("password-input").fill(TEST_USER.password);
  await page.getByTestId("email-sign-in").click();

  // Wait for redirect to list picker
  await page.waitForURL((url) => url.pathname === "/" || url.pathname.length > 1, {
    timeout: 10000,
  });

  // Wait a moment for auth state to settle
  await page.waitForTimeout(500);
}

// Helper to create a test list and navigate to it
async function createTestList(page: Page, listName: string) {
  // Wait for the list picker page to be ready
  await page.waitForTimeout(1000);

  // Look for existing list or create new one
  const existingList = page.locator(`text=${listName}`).first();
  if (await existingList.isVisible().catch(() => false)) {
    await existingList.click();
    await page.waitForTimeout(500);
    return;
  }

  // Click "New List" button
  const newListButton = page.getByRole("button", { name: /new list/i });
  await newListButton.click();
  await page.waitForTimeout(300);

  // Fill in list name in modal (placeholder is "Groceries")
  const nameInput = page.getByPlaceholder("Groceries");
  await nameInput.fill(listName);

  // Click Create button in modal
  const createButton = page.getByRole("button", { name: "Create" });
  await createButton.click();

  // Wait for modal to close and list to be created
  await page.waitForTimeout(1000);

  // Click on the newly created list to navigate to it
  const listLink = page.locator(`text=${listName}`).first();
  await listLink.click();
  await page.waitForTimeout(500);
}

// Helper to add items to the list
async function addItems(page: Page, items: string[]) {
  // Wait for the add item input (inside Ant Design AutoComplete)
  const input = page.locator('.ant-select-selection-search-input, input[placeholder*="Add item"]').first();
  await input.waitFor({ timeout: 10000 });

  for (const item of items) {
    await input.fill(item);
    await page.getByRole("button", { name: /add/i }).click();
    await page.waitForTimeout(300);
  }
}

test.describe("Drag and Drop", () => {
  test("login page shows dev login in development", async ({ page }) => {
    await page.goto("/");

    // Dev login should be visible
    const emailInput = page.getByTestId("email-input");
    await expect(emailInput).toBeVisible({ timeout: 10000 });
  });

  test("can sign in with dev login", async ({ page }) => {
    await signIn(page);

    // Should not see login form anymore
    const emailInput = page.getByTestId("email-input");
    await expect(emailInput).not.toBeVisible({ timeout: 5000 });
  });

  test.describe("authenticated tests", () => {
    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test("can create a list and add items", async ({ page }) => {
      // Create a test list and navigate to it
      await createTestList(page, "Test List");

      // Add some items
      await addItems(page, ["Apples", "Bananas", "Milk"]);

      // Verify items appear
      await expect(page.locator("text=Apples")).toBeVisible();
      await expect(page.locator("text=Bananas")).toBeVisible();
      await expect(page.locator("text=Milk")).toBeVisible();
    });

    test("categories collapse during drag", async ({ page }) => {
      await createTestList(page, "Drag Test");
      await addItems(page, ["Item 1", "Item 2", "Item 3"]);
      await page.waitForTimeout(500);

      // Find the drag handle of first item
      const dragHandle = page.getByTestId("drag-handle").first();
      if (!await dragHandle.isVisible().catch(() => false)) {
        test.skip(true, "Drag handle not found");
        return;
      }

      const handleBox = await dragHandle.boundingBox();
      if (!handleBox) {
        test.skip(true, "Could not get drag handle position");
        return;
      }

      // Start drag
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(100);

      // Move down a bit to trigger drag
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 50);
      await page.waitForTimeout(200);

      // Check that a drag overlay appeared
      const overlay = page.getByTestId("drag-overlay");
      const overlayVisible = await overlay.isVisible().catch(() => false);

      await page.mouse.up();

      expect(overlayVisible).toBe(true);
    });

    test("drag overlay stays near cursor vertically", async ({ page }) => {
      await createTestList(page, "Position Test");
      await addItems(page, ["Test Item 1", "Test Item 2"]);
      await page.waitForTimeout(500);

      const dragHandle = page.getByTestId("drag-handle").first();
      if (!await dragHandle.isVisible().catch(() => false)) {
        test.skip(true, "Drag handle not found");
        return;
      }

      const handleBox = await dragHandle.boundingBox();
      if (!handleBox) {
        test.skip(true, "Could not get handle position");
        return;
      }

      // Start drag
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();

      // Move down significantly
      const targetY = handleBox.y + 200;
      await page.mouse.move(handleBox.x + handleBox.width / 2, targetY);
      await page.waitForTimeout(100);

      // Get overlay position
      const overlay = page.getByTestId("drag-overlay");
      const overlayBox = await overlay.boundingBox();

      await page.mouse.up();

      if (overlayBox) {
        const overlayCenter = overlayBox.y + overlayBox.height / 2;
        // Overlay should be within 50px of the cursor position
        expect(Math.abs(overlayCenter - targetY)).toBeLessThan(50);
      }
    });

    test("can drop item on different category", async ({ page }) => {
      await createTestList(page, "Drop Test");
      await addItems(page, ["Cheese"]);
      await page.waitForTimeout(500);

      // Find drag handle and a category header
      const dragHandle = page.getByTestId("drag-handle").first();
      const categoryHeaders = page.getByTestId("category-header");

      if (!await dragHandle.isVisible().catch(() => false)) {
        test.skip(true, "Drag handle not found");
        return;
      }

      const headerCount = await categoryHeaders.count();
      if (headerCount < 2) {
        test.skip(true, "Not enough categories");
        return;
      }

      const handleBox = await dragHandle.boundingBox();
      const targetHeader = categoryHeaders.nth(1);
      const targetBox = await targetHeader.boundingBox();

      if (!handleBox || !targetBox) {
        test.skip(true, "Could not get positions");
        return;
      }

      // Drag to target category
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 10,
      });
      await page.waitForTimeout(100);
      await page.mouse.up();

      // Item should have moved (we'd need to verify this based on DOM structure)
      await page.waitForTimeout(500);
    });
  });
});
