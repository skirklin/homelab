/**
 * Cooking log + diff modal — rendered end-to-end.
 *
 * The recipeDiff unit tests cover the pure-function diff; this spec covers
 * the React/AntD render + integration path: the "I made it!" flow, the diff
 * button visibility, the modal contents, and the legacy "no snapshot" row
 * behavior (button disabled + tooltip wording).
 *
 * Seeds the recipe via admin PB so the test owns the snapshot state
 * precisely. Then drives every assertion through the UI.
 */
import { test, expect, type Page } from "./fixtures";

test.setTimeout(60_000);

/**
 * "I made it!" → fill optional note → Save. Returns once the modal closes
 * (and, when a note was supplied, the entry text is visible in the log).
 *
 * We deliberately don't assert on the AntD toast — it can come and go
 * faster than the assertion window during a fast test run.
 */
async function logCook(page: Page, note?: string): Promise<void> {
  await page.getByRole("button", { name: /I made it!/i }).click();
  const modal = page.getByRole("dialog", { name: /I made it/i });
  await expect(modal).toBeVisible({ timeout: 5000 });
  if (note) {
    await modal.locator("textarea").fill(note);
  }
  await modal.getByRole("button", { name: /save/i }).click();
  // Modal closes once the create resolves.
  await expect(modal).not.toBeVisible({ timeout: 10_000 });
  // The CookingLog renders the note wrapped in literal quotes — that's
  // narrow enough to disambiguate from any input/textarea with the same
  // raw text content.
  if (note) {
    await expect(page.getByText(`"${note}"`, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  }
}

/** Count cooking-log entries currently rendered. Each one wraps in a
 *  LogEntryContainer with the "made this on" meta line. */
async function entryCount(page: Page): Promise<number> {
  return page.getByText(/made this on/).count();
}

test.describe("Cooking log + diff modal", () => {
  test("logs a cook, diffs against later edits, shows tooltip on snapshotless entry", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Cook Log Owner" });

    // Seed a box + recipe with a small ingredient list.
    const box = await adminPb.collection("recipe_boxes").create({
      name: `Cook Log Box ${Date.now()}`,
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
        name: `Diffable Recipe ${Date.now()}`,
        recipeIngredient: ["1 cup flour", "1 egg"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Mix and cook." }],
      },
    });

    // Open the recipe.
    await owner.page.goto(`/boxes/${box.id}/recipes/${recipe.id}`);
    await expect(
      owner.page.getByRole("heading", { name: /Diffable Recipe/ })
    ).toBeVisible({ timeout: 10_000 });

    // --- Log the first cook (pre-edit baseline snapshot) ---
    await logCook(owner.page, "first round");
    // entryCount counts "made this on" lines which only render per log entry.
    expect(await entryCount(owner.page)).toBe(1);

    // First entry should have an enabled diff button (snapshot non-null).
    // Pre-edit: clicking it should show "No changes since this cook."
    const firstDiffBtn = owner.page.locator(".anticon-diff").first();
    await expect(firstDiffBtn).toBeVisible({ timeout: 5000 });
    await firstDiffBtn.click();
    const noChangesModal = owner.page.getByRole("dialog", { name: /what changed/i });
    await expect(noChangesModal).toBeVisible({ timeout: 5000 });
    await expect(noChangesModal.getByText(/no changes since this cook/i)).toBeVisible({
      timeout: 5000,
    });
    // Modal close: AntD wires the X aria-label="Close" button reliably;
    // Escape doesn't always propagate from the textbox/popper layer in
    // headless chromium.
    await owner.page.getByRole("button", { name: "Close" }).first().click();
    await expect(noChangesModal).not.toBeVisible({ timeout: 5000 });

    // --- Edit the recipe directly via admin so we know exactly what changed ---
    await adminPb.collection("recipes").update(recipe.id, {
      data: {
        name: recipe.data.name,
        recipeIngredient: ["1 cup flour", "1 egg", "1 tsp salt"],
        recipeInstructions: recipe.data.recipeInstructions,
      },
    });

    // Reload so the recipe subscription picks up the new state. The cooking
    // log preserves the original snapshot, so diff vs current should now
    // show an addition.
    await owner.page.reload();
    await expect(
      owner.page.getByRole("heading", { name: /Diffable Recipe/ })
    ).toBeVisible({ timeout: 10_000 });

    const firstDiffBtnAfter = owner.page.locator(".anticon-diff").first();
    await firstDiffBtnAfter.click();
    const diffModal = owner.page.getByRole("dialog", { name: /what changed/i });
    await expect(diffModal).toBeVisible({ timeout: 5000 });

    // Ingredients section appears with the added row.
    await expect(diffModal.getByText("Ingredients")).toBeVisible({ timeout: 5000 });
    await expect(diffModal.getByText(/1 tsp salt/)).toBeVisible({ timeout: 5000 });
    // The "no changes" sentinel should be absent now.
    await expect(diffModal.getByText(/no changes since this cook/i)).not.toBeVisible();
    // Modal close: AntD wires the X aria-label="Close" button reliably;
    // Escape doesn't always propagate from the textbox/popper layer in
    // headless chromium.
    await owner.page.getByRole("button", { name: "Close" }).first().click();
    await expect(diffModal).not.toBeVisible({ timeout: 5000 });

    // --- Log a fresh cook AFTER the edit ---
    await logCook(owner.page, "second round");
    expect(await entryCount(owner.page)).toBe(2);

    // The newest entry is rendered first (sort: -timestamp). Its diff button
    // should show "No changes since this cook." — the new snapshot matches
    // current.
    const newestDiffBtn = owner.page.locator(".anticon-diff").first();
    await newestDiffBtn.click();
    const freshModal = owner.page.getByRole("dialog", { name: /what changed/i });
    await expect(freshModal).toBeVisible({ timeout: 5000 });
    await expect(freshModal.getByText(/no changes since this cook/i)).toBeVisible({
      timeout: 5000,
    });
    // Modal close: AntD wires the X aria-label="Close" button reliably;
    // Escape doesn't always propagate from the textbox/popper layer in
    // headless chromium.
    await owner.page.getByRole("button", { name: "Close" }).first().click();
    await expect(freshModal).not.toBeVisible({ timeout: 5000 });

    // --- Insert a legacy snapshotless entry directly via admin ---
    // Timestamp old enough to sort to the bottom of the list.
    const legacyTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await adminPb.collection("recipe_events").create({
      box: box.id,
      subject_id: recipe.id,
      timestamp: legacyTs,
      created_by: owner.user.id,
      entries: [{ name: "notes", type: "text", value: "legacy cook" }],
      recipe_snapshot: null,
    });
    // Reload to pick up the new entry.
    await owner.page.reload();
    await expect(owner.page.getByText(/legacy cook/)).toBeVisible({ timeout: 10_000 });
    expect(await entryCount(owner.page)).toBe(3);

    // The legacy entry's diff button is disabled — sorted last by timestamp.
    const allDiffBtns = owner.page.locator(".anticon-diff");
    const totalBtns = await allDiffBtns.count();
    expect(totalBtns).toBe(3);
    // The disabled button is the AntD Button with disabled attribute on its
    // wrapping element. Easiest is to assert via the parent button selector.
    const lastDiffButton = owner.page.locator("button:has(.anticon-diff)").last();
    await expect(lastDiffButton).toBeDisabled();

    // Tooltip wording — hover the wrapping span and assert the tooltip
    // contents. AntD's <Tooltip> renders into a portal as role="tooltip".
    await lastDiffButton.hover();
    await expect(
      owner.page.getByRole("tooltip", { name: /no snapshot.*predates this feature/i })
    ).toBeVisible({ timeout: 5000 });
  });
});
