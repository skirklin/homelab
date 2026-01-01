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
    // Clear saved path to avoid auto-redirect
    await page.evaluate(() => localStorage.removeItem("home:lastPath"));

    // Go to groceries
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);

    // Clear saved path again before going home
    await page.evaluate(() => localStorage.removeItem("home:lastPath"));

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

  test("shows list picker with New List button", async ({ page }) => {
    // Should see "My Lists" title and New List button
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible();
  });

  test("can create a new list and navigate into it", async ({ page }) => {
    // Wait for list picker to load
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });

    // Click New List button
    await page.getByRole("button", { name: /new list/i }).click();

    // Fill in the modal - use unique name to avoid conflicts
    const listName = `Test ${Date.now()}`;
    const expectedSlug = listName.toLowerCase().replace(/\s+/g, "-");
    await page.getByPlaceholder("Groceries").fill(listName);

    // Create
    await page.getByRole("button", { name: "Create" }).click();

    // Should navigate to the new list
    await expect(page).toHaveURL(new RegExp(`/groceries/${expectedSlug}`), { timeout: 5000 });
  });

  test("back button from list navigates to list picker", async ({ page }) => {
    // Wait for list picker and create a list
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /new list/i }).click();

    const listName = `Back Test ${Date.now()}`;
    await page.getByPlaceholder("Groceries").fill(listName);
    await page.getByRole("button", { name: "Create" }).click();

    // Wait until we're in the list (URL has slug)
    await expect(page).toHaveURL(/\/groceries\/back-test-/, { timeout: 5000 });

    // Find and click back button (arrow-left icon button)
    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await expect(backButton).toBeVisible({ timeout: 5000 });
    await backButton.click();

    // CRITICAL: Should go to /groceries (list picker), NOT stay at the list or go home
    // The URL should be exactly /groceries or /groceries?pick=true
    await expect(page).toHaveURL(/\/groceries\/?(\?|$)/, { timeout: 5000 });

    // Verify we see the list picker content
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 5000 });
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

  test("shows list picker with New Task List button", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /upkeep/i })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible();
  });

  test("can create a task list and navigate into it", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /new task list/i }).click();

    const listName = `Tasks ${Date.now()}`;
    const expectedSlug = listName.toLowerCase().replace(/\s+/g, "-");
    await page.getByPlaceholder(/home/i).fill(listName);
    await page.getByRole("button", { name: /create/i }).click();

    // Should navigate to the new list
    await expect(page).toHaveURL(new RegExp(`/upkeep/${expectedSlug}`), { timeout: 5000 });
  });

  test("back button from task list navigates to list picker", async ({ page }) => {
    // Wait for list picker and create a list
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /new task list/i }).click();

    const listName = `Upkeep Back ${Date.now()}`;
    await page.getByPlaceholder(/home/i).fill(listName);
    await page.getByRole("button", { name: /create/i }).click();

    // Wait until we're in the list
    await expect(page).toHaveURL(/\/upkeep\/upkeep-back-/, { timeout: 5000 });

    // Find and click back button
    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await expect(backButton).toBeVisible({ timeout: 5000 });
    await backButton.click();

    // CRITICAL: Should go to /upkeep (list picker), NOT stay at the list or go home
    await expect(page).toHaveURL(/\/upkeep\/?(\?|$)/, { timeout: 5000 });

    // Verify we see the list picker content (heading says "Upkeep")
    await expect(page.getByRole("heading", { name: /upkeep/i })).toBeVisible({ timeout: 5000 });
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

  test("navigating into groceries list and back stays in module", async ({ page }) => {
    // Go to groceries
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });

    // Create a list
    await page.getByRole("button", { name: /new list/i }).click();
    await page.getByPlaceholder("Groceries").fill(`Cross Test ${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();

    // Verify we're in a list (URL has slug)
    await expect(page).toHaveURL(/\/groceries\/cross-test-/, { timeout: 5000 });

    // Click back
    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await backButton.click();

    // MUST stay in groceries, not go to home
    await expect(page).toHaveURL(/\/groceries\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByText("My Lists")).toBeVisible();
  });

  test("navigating into upkeep list and back stays in module", async ({ page }) => {
    // Go to upkeep
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });

    // Create a list
    await page.getByRole("button", { name: /new task list/i }).click();
    await page.getByPlaceholder(/home/i).fill(`Cross Upkeep ${Date.now()}`);
    await page.getByRole("button", { name: /create/i }).click();

    // Verify we're in a list
    await expect(page).toHaveURL(/\/upkeep\/cross-upkeep-/, { timeout: 5000 });

    // Click back
    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await backButton.click();

    // MUST stay in upkeep, not go to home
    await expect(page).toHaveURL(/\/upkeep\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByRole("heading", { name: /upkeep/i })).toBeVisible();
  });

  test("rapid navigation between modules preserves correct URLs", async ({ page }) => {
    // Navigate through multiple modules quickly
    await page.getByRole("button", { name: /groceries/i }).click();
    await expect(page).toHaveURL(/\/groceries/);

    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);

    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);

    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);

    // Clear saved path before going home (the app saves last-used module)
    await page.evaluate(() => localStorage.removeItem("home:lastPath"));

    // Go back to home
    await page.getByRole("button", { name: /home/i }).click();
    await expect(page).toHaveURL("/");
  });
});
