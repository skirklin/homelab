import { test, expect } from "@playwright/test";

// Note: These tests require authentication. For now, they test the UI structure.
// TODO: Set up Firebase Auth emulator or test user for full E2E testing.

test.describe("Drag and Drop", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app - will show login if not authenticated
    await page.goto("/");
  });

  test("login page loads", async ({ page }) => {
    // Basic smoke test - page should load
    await expect(page).toHaveTitle(/Groceries/);
  });

  // These tests require authentication to run properly
  test.describe("with authenticated user", () => {
    test.skip(true, "Requires Firebase Auth setup");

    test("drag overlay follows cursor vertically when dragging", async ({ page }) => {
      // Navigate to a list
      await page.goto("/groceries");

      // Find an item to drag
      const item = page.locator('[data-testid="grocery-item"]').first();
      const itemBox = await item.boundingBox();
      if (!itemBox) throw new Error("Item not found");

      // Start drag
      await page.mouse.move(itemBox.x + 10, itemBox.y + itemBox.height / 2);
      await page.mouse.down();

      // Move cursor down
      await page.mouse.move(itemBox.x + 10, itemBox.y + 200);

      // Check overlay is near cursor (vertically centered)
      const overlay = page.locator('[class*="DragItem"]');
      const overlayBox = await overlay.boundingBox();
      if (!overlayBox) throw new Error("Overlay not found");

      // Overlay center should be close to cursor Y position
      const overlayCenter = overlayBox.y + overlayBox.height / 2;
      const cursorY = itemBox.y + 200;
      expect(Math.abs(overlayCenter - cursorY)).toBeLessThan(20);

      await page.mouse.up();
    });

    test("drag overlay position is correct when page is scrolled", async ({ page }) => {
      await page.goto("/groceries");

      // Scroll down the page
      await page.evaluate(() => window.scrollTo(0, 300));

      // Find an item after scroll
      const item = page.locator('[data-testid="grocery-item"]').first();
      const itemBox = await item.boundingBox();
      if (!itemBox) throw new Error("Item not found");

      // Start drag
      await page.mouse.move(itemBox.x + 10, itemBox.y + itemBox.height / 2);
      await page.mouse.down();

      // Check overlay is near the cursor, not offset by scroll
      const overlay = page.locator('[class*="DragItem"]');
      const overlayBox = await overlay.boundingBox();
      if (!overlayBox) throw new Error("Overlay not found");

      const overlayCenter = overlayBox.y + overlayBox.height / 2;
      const cursorY = itemBox.y + itemBox.height / 2;
      expect(Math.abs(overlayCenter - cursorY)).toBeLessThan(20);

      await page.mouse.up();
    });

    test("categories collapse during drag", async ({ page }) => {
      await page.goto("/groceries");

      const item = page.locator('[data-testid="grocery-item"]').first();
      const itemBox = await item.boundingBox();
      if (!itemBox) throw new Error("Item not found");

      // Get category count before drag
      const categoryHeaders = page.locator('[class*="CategoryHeader"]');
      const countBefore = await categoryHeaders.count();

      // Start drag
      await page.mouse.move(itemBox.x + 10, itemBox.y + itemBox.height / 2);
      await page.mouse.down();

      // Categories should still be visible (headers), but content collapsed
      const itemContainers = page.locator('[class*="ItemsContainer"]');
      for (let i = 0; i < await itemContainers.count(); i++) {
        const container = itemContainers.nth(i);
        const height = await container.evaluate((el) => el.getBoundingClientRect().height);
        // Collapsed containers should have minimal height
        expect(height).toBeLessThan(50);
      }

      await page.mouse.up();
    });

    test("drop on category header changes item category", async ({ page }) => {
      await page.goto("/groceries");

      const item = page.locator('[data-testid="grocery-item"]').first();
      const itemName = await item.textContent();
      const itemBox = await item.boundingBox();
      if (!itemBox) throw new Error("Item not found");

      // Find a different category header
      const targetCategory = page.locator('[class*="CategoryHeader"]').nth(1);
      const targetBox = await targetCategory.boundingBox();
      if (!targetBox) throw new Error("Target category not found");

      // Drag and drop
      await page.mouse.move(itemBox.x + 10, itemBox.y + itemBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetBox.x + 10, targetBox.y + targetBox.height / 2);
      await page.mouse.up();

      // Item should now be in the target category
      // (This would need to check the actual DOM structure or wait for Firebase sync)
    });
  });
});
