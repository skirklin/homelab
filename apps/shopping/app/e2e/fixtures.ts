import { test as base, expect, type Page } from "@playwright/test";

const TEST_EMAIL = "playwright@test.local";
const TEST_EMAIL_2 = "playwright2@test.local";
const TEST_PASSWORD = "testpassword123";

/**
 * Sign in via the email/password form on the Auth page.
 */
async function signIn(page: Page) {
  await page.fill('[data-testid="email-input"]', TEST_EMAIL);
  await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
  await page.click('[data-testid="email-sign-in"]');
  // Wait for auth to complete — the auth page should disappear
  await expect(page.locator('[data-testid="email-sign-in"]')).not.toBeVisible({
    timeout: 10000,
  });
}

/**
 * Extended test fixture that auto-signs in.
 */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await page.goto("/?pick=true");
    await signIn(page);
    await use(page);
  },
});

async function signInAsUser2(page: Page) {
  await page.fill('[data-testid="email-input"]', TEST_EMAIL_2);
  await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
  await page.click('[data-testid="email-sign-in"]');
  await expect(page.locator('[data-testid="email-sign-in"]')).not.toBeVisible({
    timeout: 10000,
  });
}

export { expect, signIn, signInAsUser2 };
