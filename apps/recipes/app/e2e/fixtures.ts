/**
 * Playwright fixtures + helpers for the recipes app.
 *
 * - `adminPb` — superuser-authed PocketBase client for seeding test data.
 *   Owned per-test by the fixture so cleanup runs deterministically.
 * - `signedInPage` — a Page already signed in as a freshly-minted user.
 *   Each call mints a unique user so tests are mutually isolated even when
 *   they run sequentially against a shared PB.
 *
 * Auth flow: we go through the rendered email/password form (testids added
 * to Auth.tsx) rather than injecting `pb_auth` into localStorage. The form
 * route also exercises the AuthProvider rehydration path the app actually
 * uses in production, so failures there surface here too.
 */
import { test as base, expect, type Page, type BrowserContext, type Browser } from "@playwright/test";
import PocketBase from "pocketbase";

const PB_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";
const ADMIN_EMAIL = "test-admin@test.local";
const ADMIN_PASSWORD = "testpassword1234";
const USER_PASSWORD = "testpassword123";

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Create a superuser-authed PB client. Idempotent — if no superuser exists,
 * creates the canonical test admin; otherwise just signs in.
 */
export async function newAdminPb(): Promise<PocketBase> {
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  try {
    await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch {
    try {
      await pb.collection("_superusers").create({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        passwordConfirm: ADMIN_PASSWORD,
      });
      await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    } catch (e) {
      throw new Error(
        `Failed to auth as PB admin at ${PB_URL}: ${(e as Error).message}`
      );
    }
  }
  return pb;
}

/** Mint a new user via admin client. */
export async function createUser(
  adminPb: PocketBase,
  opts?: { name?: string }
): Promise<TestUser> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `pw-${stamp}@test.local`;
  const name = opts?.name || `PW User ${stamp}`;
  const record = await adminPb.collection("users").create({
    email,
    password: USER_PASSWORD,
    passwordConfirm: USER_PASSWORD,
    name,
  });
  return { id: record.id, email, name };
}

/**
 * Drive the standalone recipes app's sign-in form. The form lives at the
 * root path when there's no auth, which is exactly where `?pick=true` is a
 * no-op (the param is shopping-specific). Standalone recipes lands on
 * Contents (`/`) on success.
 */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/");
  const emailInput = page.getByTestId("email-input");
  await emailInput.waitFor({ timeout: 15000 });
  await emailInput.fill(user.email);
  await page.getByTestId("password-input").fill(USER_PASSWORD);
  await page.getByTestId("email-sign-in").click();
  // Auth screen disappears once we have a session
  await expect(page.getByTestId("email-input")).not.toBeVisible({ timeout: 15000 });
}

/**
 * Open a fresh browser context, mint a user, and sign them in. Returns the
 * Page + Context so the caller can close it deterministically (we close all
 * spawned contexts in the fixture's teardown).
 */
export async function newSignedInPage(
  browser: Browser,
  adminPb: PocketBase,
  opts?: { name?: string }
): Promise<{ page: Page; context: BrowserContext; user: TestUser }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const user = await createUser(adminPb, opts);
  await signIn(page, user);
  return { page, context, user };
}

type Fixtures = {
  adminPb: PocketBase;
  /** Sign-in helper that also tracks contexts for teardown. */
  signedInPage: (opts?: { name?: string }) => Promise<{ page: Page; context: BrowserContext; user: TestUser }>;
};

export const test = base.extend<Fixtures>({
  adminPb: async ({}, use) => {
    const pb = await newAdminPb();
    await use(pb);
  },
  signedInPage: async ({ browser, adminPb }, use) => {
    const contexts: BrowserContext[] = [];
    const helper = async (opts?: { name?: string }) => {
      const result = await newSignedInPage(browser, adminPb, opts);
      contexts.push(result.context);
      return result;
    };
    await use(helper);
    for (const ctx of contexts) {
      await ctx.close().catch(() => undefined);
    }
  },
});

export { expect };
