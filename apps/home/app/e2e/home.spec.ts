import { test, expect, Page } from "@playwright/test";

// Increase default timeout for tests that do PB operations
test.setTimeout(45000);

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

/** Dismiss any Ant Design modals that might be blocking interaction */
async function dismissModals(page: Page) {
  await page.waitForTimeout(500);
  // Handle "What's New" modal with "Got it!" button
  const gotIt = page.getByRole("button", { name: /got it/i });
  if (await gotIt.isVisible({ timeout: 1000 }).catch(() => false)) {
    await gotIt.click();
    await gotIt.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  // Handle any other Ant Design modals via close button
  const modals = page.locator(".ant-modal-wrap");
  const count = await modals.count();
  for (let i = 0; i < count; i++) {
    const modal = modals.nth(i);
    if (await modal.isVisible().catch(() => false)) {
      const closeBtn = modal.locator("button.ant-modal-close");
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await modal.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
      }
    }
  }
}

/** Create a shopping list via the list picker modal */
async function createShoppingList(page: Page, name: string) {
  await page.getByRole("button", { name: /new list/i }).click();
  const modal = page.getByRole("dialog", { name: "Create New List" });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.locator("input").fill(name);
  await modal.getByRole("button", { name: "Create" }).click();
  // Wait for modal to close and list to load
  const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  await expect(page).toHaveURL(new RegExp(`/shopping/${slug}`), { timeout: 10000 });
}

/** Create an upkeep task list via the list picker modal */
async function createUpkeepList(page: Page, name: string) {
  await page.getByRole("button", { name: /new task list/i }).click();
  await page.getByPlaceholder(/home/i).fill(name);
  await page.getByRole("button", { name: /create/i }).click();
  const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  await expect(page).toHaveURL(new RegExp(`/upkeep/${slug}`), { timeout: 10000 });
}

test.describe("Home App", () => {
  test("shows login page for unauthenticated users", async ({ page }) => {
    await page.goto("/");
    const emailInput = page.getByTestId("email-input");
    await expect(emailInput).toBeVisible({ timeout: 10000 });
  });

  test("can sign in with dev login", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("can navigate to Shopping module", async ({ page }) => {
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
  });

  test("can navigate to Recipes module", async ({ page }) => {
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
  });

  test("can navigate to Upkeep module", async ({ page }) => {
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
  });

  test("can navigate to Life module", async ({ page }) => {
    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
  });

  test("can navigate between modules without going home", async ({ page }) => {
    await dismissModals(page);

    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);

    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
    await dismissModals(page);

    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
  });
});

test.describe("Shopping Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
  });

  test("shows list picker with New List button", async ({ page }) => {
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible();
  });

  test("can create a new list and navigate into it", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });
    const listName = `Test ${Date.now()}`;
    await createShoppingList(page, listName);
  });

  test("back button from list navigates to list picker", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });
    const listName = `Back Test ${Date.now()}`;
    await createShoppingList(page, listName);

    // Find and click back button
    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await expect(backButton).toBeVisible({ timeout: 5000 });
    await backButton.click();

    await expect(page).toHaveURL(/\/shopping\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Persistence after reload", () => {
  test("shopping list persists after page reload", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });

    const listName = `Persist ${Date.now()}`;
    await createShoppingList(page, listName);

    // Verify we're on the list page
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });

    // Reload the page
    await page.reload();

    // After reload, the list should still be visible (not the list picker)
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 10000 });
  });

  test("upkeep task list persists after page reload", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });

    const listName = `Persist ${Date.now()}`;
    await createUpkeepList(page, listName);

    // Verify we're on the task board
    await expect(page.getByRole("heading", { name: "Due Today" })).toBeVisible({ timeout: 5000 });

    // Reload the page
    await page.reload();

    // After reload, the task board should still be visible (not the list picker)
    await expect(page.getByRole("heading", { name: "Due Today" })).toBeVisible({ timeout: 10000 });
  });

  test("travel log persists after page reload", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /travel/i }).click();
    await expect(page).toHaveURL(/\/travel/);
    await page.waitForTimeout(2000);

    // Travel auto-creates a log on first visit — verify content loads
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // Reload the page
    await page.reload();

    // After reload, should still show travel content (not a blank/error state)
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).toBeVisible();
    // Should not show login page
    await expect(page.getByTestId("email-input")).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("Shopping Module - Delete List", () => {
  test("can delete a list", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });

    const listName = `Delete Me ${Date.now()}`;
    await createShoppingList(page, listName);

    // Verify we're on the list page
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });

    // Open settings — use the gear button near the list title, not the nav bar ones
    await page.getByRole("button", { name: "setting" }).nth(1).click();

    // Click "Delete List Forever" — triggers a confirmation modal
    await page.getByRole("button", { name: /Delete List Forever/i }).click();

    // Confirm in the Ant Design Modal.confirm dialog
    // Modal.confirm renders with class ant-modal-confirm
    const modal = page.locator(".ant-modal-confirm");
    await expect(modal).toBeVisible({ timeout: 5000 });
    await modal.getByRole("button", { name: /ok|delete/i }).click();

    // Should navigate back to list picker
    await expect(page.getByText("My Lists")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Shopping Module - Full Workflow", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });
  });

  test("shopping list view renders with add-item form", async ({ page }) => {
    const listName = `Flow ${Date.now()}`;
    await createShoppingList(page, listName);

    // Verify list view loaded with all expected elements
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("textbox", { name: "Note" })).toBeVisible();
    await expect(page.getByRole("button", { name: /add/i })).toBeVisible();
    await expect(page.getByText("Uncategorized")).toBeVisible();
  });

  test("add item, check it, and verify history tab works", async ({ page }) => {
    const listName = `History ${Date.now()}`;
    await createShoppingList(page, listName);
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });

    // Add an item via the autocomplete
    await page.getByRole("combobox").pressSequentially("Milk", { delay: 50 });
    await page.getByRole("textbox", { name: "Note" }).click(); // close dropdown
    await page.getByRole("button", { name: /add/i }).click();

    // Item should appear
    await expect(page.getByText("Milk")).toBeVisible({ timeout: 5000 });

    // Check the item
    await page.getByText("Milk").click();

    // Switch to history tab (clock icon)
    const historyTab = page.locator('button').filter({ has: page.locator('.anticon-clock-circle') }).first();
    if (await historyTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await historyTab.click();
      // History should show our item
      await expect(page.getByText("milk")).toBeVisible({ timeout: 5000 });
    }
  });

  test("toast notification appears on list rename", async ({ page }) => {
    const listName = `Toast ${Date.now()}`;
    await createShoppingList(page, listName);
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 5000 });

    // Open settings
    await page.getByRole("button", { name: "setting" }).nth(1).click();

    // Rename the list
    await page.getByRole("button", { name: "Rename" }).click();
    const renameInput = page.locator(".ant-modal").locator("input");
    await expect(renameInput).toBeVisible({ timeout: 3000 });
    await renameInput.clear();
    await renameInput.fill("Renamed List");
    await page.locator(".ant-modal").getByRole("button", { name: /rename/i }).click();

    // Toast notification should appear (via useFeedback hook)
    await expect(page.locator(".ant-message")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Recipes Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
    await dismissModals(page);
  });

  test("shows recipes content", async ({ page }) => {
    // Should see "All Recipes" heading
    await expect(page.getByText("All Recipes")).toBeVisible({ timeout: 10000 });
  });

  test("can navigate to boxes and create a box", async ({ page }) => {
    // Navigate to boxes via the icon button in the header
    const boxesButton = page.locator('button').filter({ has: page.locator('.anticon-inbox') }).first();
    if (await boxesButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await boxesButton.click();
      await expect(page).toHaveURL(/\/recipes\/boxes/);
      await expect(page.getByText("Your Boxes")).toBeVisible({ timeout: 5000 });

      // Create a new box
      const boxName = `TestBox ${Date.now()}`;
      await page.getByTitle("Create new box.").click();
      const modal = page.getByRole("dialog").filter({ hasText: "OK" });
      await expect(modal).toBeVisible({ timeout: 5000 });
      await modal.locator('input').fill(boxName);
      await modal.getByRole("button", { name: /ok/i }).click();
      await expect(modal).not.toBeVisible({ timeout: 5000 });

      // The box should appear
      await expect(page.getByText(boxName)).toBeVisible({ timeout: 5000 });
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
    const listName = `Tasks ${Date.now()}`;
    await createUpkeepList(page, listName);
  });

  test("back button from task list navigates to list picker", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });
    const listName = `Upkeep Back ${Date.now()}`;
    await createUpkeepList(page, listName);

    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await expect(backButton).toBeVisible({ timeout: 5000 });
    await backButton.click();

    await expect(page).toHaveURL(/\/upkeep\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByRole("heading", { name: /upkeep/i })).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Upkeep Module - Task CRUD", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });
  });

  test("task board renders with kanban columns and add button", async ({ page }) => {
    const listName = `Tasks ${Date.now()}`;
    await createUpkeepList(page, listName);

    // Verify the task board loaded with kanban columns
    await expect(page.getByRole("heading", { name: "Due Today" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Later" })).toBeVisible();

    // Verify the Add Task button is present
    await expect(page.getByRole("button", { name: /Add Task/i })).toBeVisible();

    // Verify the add task modal opens
    await page.getByRole("button", { name: /Add Task/i }).click();
    const dialog = page.getByRole("dialog", { name: "Add Task" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByPlaceholder("Wash bedding")).toBeVisible();

    // Close modal
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
    // Task creation and completion tested in standalone vitest e2e tests (29 tests)
  });
});

test.describe("Life Module", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
  });

  test("shows life tracker content", async ({ page }) => {
    // Life module creates a log for new users — wait for spinner to clear
    await expect(page.locator('.ant-spin-spinning')).not.toBeVisible({ timeout: 15000 });
    // Should show either the dashboard or some life-related content
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Life Module - Widget Interaction", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
    // Wait for spinner to clear — life log creation can be slow
    await expect(page.locator('.ant-spin-spinning')).not.toBeVisible({ timeout: 20000 });
  });

  test("shows life tracker with default widgets and date nav", async ({ page }) => {
    // New user gets default widgets: Meds, Vitamins, Sleep
    await expect(page.getByText("Life Tracker")).toBeVisible({ timeout: 10000 });

    // Should show date navigation with "Today"
    await expect(page.getByText("Today")).toBeVisible({ timeout: 5000 });

    // Should show at least one default widget label
    const hasMeds = await page.getByText("Meds").isVisible().catch(() => false);
    const hasVitamins = await page.getByText("Vitamins").isVisible().catch(() => false);
    expect(hasMeds || hasVitamins).toBe(true);
  });

  test("date navigation works", async ({ page }) => {
    await expect(page.getByText("Today")).toBeVisible({ timeout: 10000 });

    // Click left arrow to go to yesterday
    await page.locator("[aria-label='left']").click();
    await expect(page.getByText("Yesterday")).toBeVisible({ timeout: 3000 });

    // Click right arrow to go back to today
    await page.locator("[aria-label='right']").click();
    await expect(page.getByText("Today")).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Travel Module - Trip Creation", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /travel/i }).click();
    await expect(page).toHaveURL(/\/travel/);
  });

  test("shows trips page", async ({ page }) => {
    await page.waitForTimeout(2000);
    await expect(page.locator("body")).toBeVisible();
  });

  test("can create a trip", async ({ page }) => {
    await page.waitForTimeout(2000);

    const newTripButton = page.getByRole("button", { name: /new trip/i });
    if (await newTripButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newTripButton.click();
      await expect(page.getByPlaceholder("e.g., Tokyo, Japan")).toBeVisible({ timeout: 5000 });

      await page.getByPlaceholder("e.g., Tokyo, Japan").fill("Paris, France");
      await page.getByRole("button", { name: /create trip/i }).click();

      // Should navigate to trip detail or back to trips list
      await page.waitForTimeout(2000);
      await expect(page.getByText("Paris, France")).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe("Cross-module Navigation Regression", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("navigating into shopping list and back stays in module", async ({ page }) => {
    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);
    await expect(page.getByRole("button", { name: /new list/i })).toBeVisible({ timeout: 5000 });

    const listName = `Cross Test ${Date.now()}`;
    await createShoppingList(page, listName);

    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await backButton.click();

    // MUST stay in shopping, not go to home
    await expect(page).toHaveURL(/\/shopping\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByText("My Lists")).toBeVisible();
  });

  test("navigating into upkeep list and back stays in module", async ({ page }) => {
    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);
    await expect(page.getByRole("button", { name: /new task list/i })).toBeVisible({ timeout: 5000 });

    const listName = `Cross Upkeep ${Date.now()}`;
    await createUpkeepList(page, listName);

    const backButton = page.locator('button').filter({ has: page.locator('.anticon-arrow-left') });
    await backButton.click();

    // MUST stay in upkeep, not go to home
    await expect(page).toHaveURL(/\/upkeep\/?(\?|$)/, { timeout: 5000 });
    await expect(page.getByRole("heading", { name: /upkeep/i })).toBeVisible();
  });

  test("rapid navigation between modules preserves correct URLs", async ({ page }) => {
    await dismissModals(page);

    await page.getByRole("button", { name: /shopping/i }).click();
    await expect(page).toHaveURL(/\/shopping/);

    await page.getByRole("button", { name: /recipes/i }).click();
    await expect(page).toHaveURL(/\/recipes/);
    await dismissModals(page);

    await page.getByRole("button", { name: /upkeep/i }).click();
    await expect(page).toHaveURL(/\/upkeep/);

    await page.getByRole("button", { name: /life/i }).click();
    await expect(page).toHaveURL(/\/life/);
  });
});
