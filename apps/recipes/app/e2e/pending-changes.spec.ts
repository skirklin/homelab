/**
 * Pending-changes review UI — end-to-end.
 *
 * The PendingChangesReview banner currently exposes whole-accept and
 * whole-dismiss buttons — there is no per-section accept/reject toggle in
 * the rendered UI (see RecipeCard/PendingChangesReview.tsx). This spec
 * locks down the two paths that DO exist:
 *
 *   - Accept enrichment changes → recipe.data picks up the changes,
 *     pending_changes clears, enrichment_status becomes "done".
 *   - Dismiss enrichment changes → recipe.data stays put, pending_changes
 *     clears, enrichment_status becomes "skipped".
 *
 * Modification-source changes follow the same UI shape but flip the
 * status target ("needed" on accept). We cover one of each source so
 * the source-dispatch in applyChanges() is exercised through the UI,
 * not just the unit tests.
 *
 * If partial-accept by section ever lands in the UI, extend this spec to
 * cover it — the apply path's per-section merge logic in
 * PocketBaseRecipesBackend.applyChanges() is the trickiest bit and
 * deserves UI-driven coverage when there's a UI to drive.
 */
import { test, expect, type Page } from "./fixtures";
import type PocketBase from "pocketbase";

test.setTimeout(60_000);

interface SeedArgs {
  adminPb: PocketBase;
  ownerId: string;
  recipeName: string;
  initial: Record<string, unknown>;
  pending: Record<string, unknown>;
  enrichmentStatus?: string;
}

/** Build a fresh box + recipe with admin-set pending_changes. */
async function seedRecipeWithPending(args: SeedArgs): Promise<{ boxId: string; recipeId: string }> {
  const { adminPb, ownerId } = args;
  const box = await adminPb.collection("recipe_boxes").create({
    name: `Pending Box ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    owners: [ownerId],
    visibility: "private",
  });
  await adminPb.collection("users").update(ownerId, {
    recipe_boxes: [box.id],
  });
  const recipe = await adminPb.collection("recipes").create({
    box: box.id,
    owners: [ownerId],
    creator: ownerId,
    visibility: "private",
    data: { name: args.recipeName, ...args.initial },
    pending_changes: args.pending,
    enrichment_status: args.enrichmentStatus ?? "needed",
  });
  return { boxId: box.id, recipeId: recipe.id };
}

/** Wait for PB realtime to settle (the SET_PENDING_CHANGES → clear cycle is
 *  async; the banner unmounts when state.pendingChanges becomes undefined). */
async function expectBannerGone(page: Page, label: RegExp): Promise<void> {
  await expect(page.getByText(label)).not.toBeVisible({ timeout: 10_000 });
}

test.describe("Pending changes review", () => {
  test("accept: enrichment changes merge into recipe.data and status becomes 'done'", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Enrich Acceptor" });

    const seeded = await seedRecipeWithPending({
      adminPb,
      ownerId: owner.user.id,
      recipeName: `Plain Soup ${Date.now()}`,
      initial: { recipeIngredient: ["water"] },
      pending: {
        data: {
          description: "A rich, hearty soup",
          recipeCategory: ["soup", "comfort"],
          recipeIngredient: ["water", "1 onion", "2 carrots"],
        },
        source: "enrichment",
        reasoning: "Filled in description, tags, and missing ingredients",
        generatedAt: new Date().toISOString(),
        model: "test-model",
      },
    });

    await owner.page.goto(`/boxes/${seeded.boxId}/recipes/${seeded.recipeId}`);
    await expect(owner.page.getByRole("heading", { name: /Plain Soup/ })).toBeVisible({
      timeout: 10_000,
    });

    // Banner renders: title varies by source. Enrichment → "AI Suggestions".
    const banner = owner.page.getByText("AI Suggestions Available");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // Suggestion content surfaced in the banner body.
    await expect(owner.page.getByText("A rich, hearty soup")).toBeVisible();
    await expect(owner.page.getByText("comfort", { exact: true })).toBeVisible();

    // Click Accept (the green primary button).
    await owner.page.getByRole("button", { name: /Accept/ }).click();

    // Banner unmounts once state.pendingChanges clears.
    await expectBannerGone(owner.page, /AI Suggestions Available/);

    // Verify server-side state matches the spec for enrichment-source apply.
    const record = await adminPb.collection("recipes").getOne(seeded.recipeId);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).toBe("done");
    expect(record.data.description).toBe("A rich, hearty soup");
    expect(record.data.recipeIngredient).toEqual(["water", "1 onion", "2 carrots"]);
    // recipeCategory tags merged (case-normalized, deduped) into existing tags.
    const tags = (record.data.recipeCategory as string[]) || [];
    expect(tags).toContain("soup");
    expect(tags).toContain("comfort");
  });

  test("dismiss: enrichment changes are discarded and status becomes 'skipped'", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Enrich Dismisser" });

    const initialIngredients = ["chicken", "broth"];
    const seeded = await seedRecipeWithPending({
      adminPb,
      ownerId: owner.user.id,
      recipeName: `Stay Plain ${Date.now()}`,
      initial: { recipeIngredient: initialIngredients },
      pending: {
        data: {
          description: "Hearty chicken soup",
          recipeIngredient: ["chicken", "broth", "noodles", "carrots"],
        },
        source: "enrichment",
        reasoning: "Auto-enrich",
        generatedAt: new Date().toISOString(),
        model: "test-model",
      },
    });

    await owner.page.goto(`/boxes/${seeded.boxId}/recipes/${seeded.recipeId}`);
    await expect(owner.page.getByRole("heading", { name: /Stay Plain/ })).toBeVisible({
      timeout: 10_000,
    });

    const banner = owner.page.getByText("AI Suggestions Available");
    await expect(banner).toBeVisible({ timeout: 10_000 });

    // Click Dismiss (the non-primary, non-green button in the banner).
    await owner.page.getByRole("button", { name: /Dismiss/ }).click();
    await expectBannerGone(owner.page, /AI Suggestions Available/);

    const record = await adminPb.collection("recipes").getOne(seeded.recipeId);
    expect(record.pending_changes).toBeNull();
    expect(record.enrichment_status).toBe("skipped");
    // Recipe data should be untouched.
    expect(record.data.recipeIngredient).toEqual(initialIngredients);
    expect(record.data.description ?? "").toBe("");
  });

  test("modification source: title says 'Modifications' and status becomes 'needed' on accept", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Mod Acceptor" });

    const seeded = await seedRecipeWithPending({
      adminPb,
      ownerId: owner.user.id,
      recipeName: `Plain Chicken ${Date.now()}`,
      initial: {
        recipeInstructions: [{ "@type": "HowToStep", text: "Cook chicken." }],
      },
      pending: {
        data: {
          name: "Spiced Chicken",
          recipeInstructions: [
            { "@type": "HowToStep", text: "Season chicken with spices." },
            { "@type": "HowToStep", text: "Cook chicken." },
          ],
        },
        source: "modification",
        reasoning: "User asked for more spice",
        prompt: "add spices",
        generatedAt: new Date().toISOString(),
        model: "test-model",
      },
      enrichmentStatus: "done",
    });

    await owner.page.goto(`/boxes/${seeded.boxId}/recipes/${seeded.recipeId}`);
    await expect(owner.page.getByRole("heading", { name: /Plain Chicken|Spiced Chicken/ })).toBeVisible({
      timeout: 10_000,
    });

    // Modification source flips title + icon.
    const banner = owner.page.getByText("AI Modifications Available");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // Prompt feedback rendered.
    await expect(owner.page.getByText(/add spices/)).toBeVisible();

    await owner.page.getByRole("button", { name: /Accept/ }).click();
    await expectBannerGone(owner.page, /AI Modifications Available/);

    const record = await adminPb.collection("recipes").getOne(seeded.recipeId);
    expect(record.pending_changes).toBeNull();
    // modification-source apply leaves enrichment status as "needed" so a
    // re-enrich pass can re-suggest.
    expect(record.enrichment_status).toBe("needed");
    expect(record.data.name).toBe("Spiced Chicken");
    expect(Array.isArray(record.data.recipeInstructions)).toBe(true);
    expect(record.data.recipeInstructions).toHaveLength(2);
  });
});
