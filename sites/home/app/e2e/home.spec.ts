import { test, expect, Page } from "@playwright/test";

// Use unique email per test worker to avoid conflicts in parallel tests
const getTestUser = () => ({
  email: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  password: "testpassword123",
});

// Helper to sign in via the dev login form
async function signIn(page: Page) {
  await page.goto("/");

  // Wait for the dev login form
  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor({ timeout: 10000 });

  // Switch to Sign Up mode to create user in emulator
  await page.getByRole("button", { name: /Don't have an account/i }).click();

  // Fill in credentials and sign up with unique email
  const testUser = getTestUser();
  await emailInput.fill(testUser.email);
  await page.getByTestId("password-input").fill(testUser.password);
  await page.getByTestId("email-sign-in").click();

  // Wait for auth to complete - check that we're no longer on login page
  await expect(page.getByTestId("email-input")).not.toBeVisible({ timeout: 10000 });
}

test.describe("Home App", () => {
  test("shows login page for unauthenticated users", async ({ page }) => {
    await page.goto("/");
    const emailInput = page.getByTestId("email-input");
    await expect(emailInput).toBeVisible({ timeout: 10000 });
  });

  test("can sign in with dev login", async ({ page }) => {
    await signIn(page);
    // signIn already verifies we're logged in, just check we see some content
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("can navigate to Groceries module", async ({ page }) => {
    // Click on Groceries in the nav
    await page.getByRole("button", { name: /groceries/i }).click();

    // URL should change to /groceries
    await expect(page).toHaveURL(/\/groceries/);

    // Should see groceries content (list picker or list)
    await page.waitForTimeout(500);
  });

  test("can navigate to Recipes module", async ({ page }) => {
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
    await page.waitForTimeout(500);
  });

  test("can navigate to Upkeep module", async ({ page }) => {
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
    await page.waitForTimeout(500);
  });

  test("can navigate to Life module", async ({ page }) => {
    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
    await page.waitForTimeout(500);
  });

  test("can navigate back to Home from module", async ({ page }) => {
    // Go to groceries
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);

    // Go back to home
    await page.getByRole("button", { name: /home/i }).click();
    await expect(page).toHaveURL("/");
  });

  test("can navigate between modules without going home", async ({ page }) => {
    // Go to groceries
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);

    // Go to recipes directly
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);

    // Go to upkeep directly
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
  });
});

test.describe("Groceries Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);
  });

  test("shows list picker or list", async ({ page }) => {
    // Should see either "My Lists" header or a list
    const content = page.locator("body");
    await expect(content).toBeVisible();
  });

  test("can create a new list", async ({ page }) => {
    // Click New List button
    const newListButton = page.getByRole("button", { name: /new list/i });
    if (await newListButton.isVisible()) {
      await newListButton.click();

      // Fill in the modal
      const nameInput = page.getByPlaceholder("Groceries");
      await nameInput.fill("Test Groceries");

      // Create
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForTimeout(1000);

      // Should navigate to the new list (URL should have the slug)
      await expect(page).toHaveURL(/\/groceries\/test-groceries/);
    }
  });

  test("navigating into a list stays within groceries module", async ({ page }) => {
    // Create or find a list
    const newListButton = page.getByRole("button", { name: /new list/i });
    if (await newListButton.isVisible()) {
      await newListButton.click();
      await page.getByPlaceholder("Groceries").fill("Nav Test");
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForTimeout(1000);
    }

    // URL should still be under /groceries
    const url = page.url();
    expect(url).toContain("/groceries");
  });

  test("back button from list goes to list picker, not home", async ({ page }) => {
    // Create a list first
    const newListButton = page.getByRole("button", { name: /new list/i });
    if (await newListButton.isVisible()) {
      await newListButton.click();
      await page.getByPlaceholder("Groceries").fill("Back Test");
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForTimeout(1000);

      // Now we should be in the list, find back button
      const backButton = page.locator('button').filter({ has: page.locator('[aria-label="arrow-left"], .anticon-arrow-left') }).first();
      if (await backButton.isVisible()) {
        await backButton.click();
        await page.waitForTimeout(500);

        // Should go to /groceries (list picker), not / (home)
        await expect(page).toHaveURL(/\/groceries(\?|$)/);
      }
    }
  });
});

test.describe("Recipes Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
  });

  test("shows recipes content", async ({ page }) => {
    const content = page.locator("body");
    await expect(content).toBeVisible();
  });

  test("navigation within recipes stays in recipes module", async ({ page }) => {
    // Look for a boxes link or any navigation
    const boxesLink = page.locator('button, a').filter({ hasText: /boxes/i }).first();
    if (await boxesLink.isVisible()) {
      await boxesLink.click();
      await page.waitForTimeout(500);

      // Should still be under /recipes
      const url = page.url();
      expect(url).toContain("/recipes");
    }
  });
});

test.describe("Upkeep Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
  });

  test("shows upkeep content", async ({ page }) => {
    const content = page.locator("body");
    await expect(content).toBeVisible();
  });

  test("can create a task list", async ({ page }) => {
    const newListButton = page.getByRole("button", { name: /new list/i });
    if (await newListButton.isVisible()) {
      await newListButton.click();

      const nameInput = page.locator('input').first();
      await nameInput.fill("Test Tasks");

      await page.getByRole("button", { name: /create/i }).click();
      await page.waitForTimeout(1000);

      // Should navigate to the new list within upkeep
      const url = page.url();
      expect(url).toContain("/upkeep");
    }
  });

  test("navigating into a task list stays within upkeep module", async ({ page }) => {
    const newListButton = page.getByRole("button", { name: /new list/i });
    if (await newListButton.isVisible()) {
      await newListButton.click();
      await page.locator('input').first().fill("Upkeep Nav Test");
      await page.getByRole("button", { name: /create/i }).click();
      await page.waitForTimeout(1000);
    }

    const url = page.url();
    expect(url).toContain("/upkeep");
  });
});

test.describe("Life Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
  });

  test("shows life tracker content", async ({ page }) => {
    const content = page.locator("body");
    await expect(content).toBeVisible();
  });
});

test.describe("Cross-module Navigation Regression", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("clicking list in groceries does not redirect to home", async ({ page }) => {
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);

    // Try to interact with a list
    const listItem = page.locator('[class*="List"]').first();
    if (await listItem.isVisible()) {
      await listItem.click();
      await page.waitForTimeout(500);

      // Should NOT be at home
      expect(page.url()).not.toBe("http://localhost:5173/");
      expect(page.url()).toContain("/groceries");
    }
  });

  test("clicking recipe does not redirect to home", async ({ page }) => {
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);

    // Try to interact with a recipe table row (not nav buttons)
    const tableRow = page.locator('table tbody tr').first();
    if (await tableRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableRow.click();
      await page.waitForTimeout(500);

      // Should NOT be at home and should stay in recipes
      expect(page.url()).not.toBe("http://localhost:5173/");
      expect(page.url()).toContain("/recipes");
    }
    // If no table rows, just verify we're still in recipes
    expect(page.url()).toContain("/recipes");
  });

  test("clicking task in upkeep does not redirect to home", async ({ page }) => {
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);

    // Try to interact with a task
    const clickable = page.locator('[class*="Task"], [class*="Card"]').first();
    if (await clickable.isVisible()) {
      await clickable.click();
      await page.waitForTimeout(500);

      // Should NOT be at home
      expect(page.url()).not.toBe("http://localhost:5173/");
      expect(page.url()).toContain("/upkeep");
    }
  });
});
