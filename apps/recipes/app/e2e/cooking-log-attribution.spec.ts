/**
 * Cooking-log author attribution + box-owner display — rendered end-to-end.
 *
 * Regression guard for the "Someone made this" / "Anonymous" bug. Apps used
 * to read only their own `users` row (listRule = "id = @request.auth.id"),
 * so any user-name display that referenced a different user fell back to a
 * placeholder. The fix introduces the read-only `user_names` view collection,
 * `UserBackend.resolveNames`, and the `useUserNames` hook; CookingLog and the
 * Boxes table both use it.
 *
 * The existing `cooking-log-diff.spec.ts` covers the I-made-it! flow but only
 * asserts on `/made this on/`, which is silent about the prefix — exactly
 * where the bug lived. This spec asserts on the prefix (the author name) and
 * pins absence of the "Someone" fallback as the regression guard.
 *
 * Note: useUserNames short-circuits the current user via auth.user.name, so
 * the cooking-log test would pass on the author's own row even without the
 * view lookup. The absence-of-"Someone" assertion is what actually proves
 * the fix is wired up — the buggy code path emitted "Someone" regardless.
 *
 * The Boxes-owners test exercises the view path directly: it signs in as
 * userA, makes a box co-owned with userB, and asserts userB's name renders
 * in the row (not "Anonymous", which is the pre-fix fallback in Boxes.tsx).
 */
import { test, expect, createUser, type Page } from "./fixtures";

test.setTimeout(60_000);

/** "I made it!" → Save (no note). */
async function logCook(page: Page): Promise<void> {
  await page.getByRole("button", { name: /I made it!/i }).click();
  const modal = page.getByRole("dialog", { name: /I made it/i });
  await expect(modal).toBeVisible({ timeout: 5000 });
  await modal.getByRole("button", { name: /save/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 10_000 });
}

test.describe("Cooking log + box owners — name attribution", () => {
  test("cooking-log entry renders the author's name, never 'Someone'", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Attribution Tester" });

    // Seed a private box + recipe owned by the signed-in user.
    const box = await adminPb.collection("recipe_boxes").create({
      name: `Attribution Box ${Date.now()}`,
      owners: [owner.user.id],
      visibility: "private",
    });
    await adminPb.collection("users").update(owner.user.id, {
      recipe_boxes: [box.id],
    });
    const recipe = await adminPb.collection("recipes").create({
      box: box.id,
      owners: [owner.user.id],
      creator: owner.user.id,
      visibility: "private",
      data: {
        name: `Attribution Recipe ${Date.now()}`,
        recipeIngredient: ["1 cup flour"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Mix." }],
      },
    });

    await owner.page.goto(`/boxes/${box.id}/recipes/${recipe.id}`);
    await expect(
      owner.page.getByRole("heading", { name: /Attribution Recipe/ })
    ).toBeVisible({ timeout: 10_000 });

    await logCook(owner.page);

    // Author name is the prefix; the regression-bug fallback was "Someone".
    await expect(
      owner.page.getByText(/Attribution Tester made this on/),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await owner.page.getByText(/Someone made this on/).count(),
    ).toBe(0);
  });

  test("box-owner column resolves co-owner display names, not 'Anonymous'", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Box Owner Primary" });
    // Second owner is a non-signed-in user — created directly via admin so we
    // own the name deterministically (createUser helper requires the
    // signedInPage flow; here we just need a users row to co-own the box).
    const coOwner = await createUser(adminPb, { name: "Box Owner Secondary" });

    const box = await adminPb.collection("recipe_boxes").create({
      name: `Co-Owned Box ${Date.now()}`,
      owners: [owner.user.id, coOwner.id],
      visibility: "private",
    });
    // Both owners need the pointer; recipes' state-loader fetches the box
    // through the user's recipe_boxes list.
    await adminPb.collection("users").update(owner.user.id, {
      recipe_boxes: [box.id],
    });
    await adminPb.collection("users").update(coOwner.id, {
      recipe_boxes: [box.id],
    });

    await owner.page.goto("/boxes");
    // The box name renders in the table row once the boxes list loads.
    await expect(
      owner.page.getByText(/Co-Owned Box/),
    ).toBeVisible({ timeout: 10_000 });

    // OwnersCell renders `users.map(u => u.name).join(', ')`. Pre-fix, the
    // co-owner came through as "Anonymous". Assert the real name shows and
    // the fallback doesn't.
    await expect(
      owner.page.getByText(/Box Owner Secondary/),
    ).toBeVisible({ timeout: 10_000 });
    expect(await owner.page.getByText(/Anonymous/).count()).toBe(0);
  });
});
