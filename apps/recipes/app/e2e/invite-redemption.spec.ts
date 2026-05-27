/**
 * Invite redemption (sharing) — end-to-end through the rendered UI.
 *
 * Flow under test:
 *   1. Owner signs in, opens an owned box, generates an invite via the
 *      Sharing dropdown.
 *   2. The invite URL is dropped onto the clipboard. We intercept that to
 *      capture it without screen-scraping a toast.
 *   3. A second user signs in in their own context, visits /invite/<code>,
 *      and is redirected onto the box.
 *   4. The redeemer sees the box on their Boxes page.
 *   5. The owner refreshes their box and sees both members in the
 *      "View people" modal.
 *   6. Re-visiting the same invite URL surfaces a "could not redeem"
 *      error result (PB hook rejects already-redeemed invites).
 *
 * Box + recipe seeding is done via admin PB. The UI work is purely the
 * sharing-affordance round-trip — that's the part the test should protect.
 */
import { test, expect, type Page } from "./fixtures";

test.setTimeout(60_000);

/**
 * Click "Sharing", then "Create invite link". Replaces the in-page
 * clipboard.writeText with a capture shim and returns whatever was copied.
 *
 * Toast text alone isn't enough — the URL only shows up in the clipboard,
 * so we intercept it the same way the home app does.
 */
async function copyInviteLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = "";
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as { __copied: string }).__copied = text;
    };
  });

  // The Sharing menu is a Dropdown wrapping an ActionButton labelled "Sharing".
  await page.getByRole("button", { name: /sharing/i }).first().click();
  const inviteItem = page.getByText("Create invite link");
  await expect(inviteItem).toBeVisible({ timeout: 5000 });
  await inviteItem.click();

  // Poll the clipboard shim — the AntD toast can flash too quickly to assert
  // on, but the clipboard write is the actual deliverable. waitForFunction
  // re-evaluates until a non-empty string lands or the timeout fires; we
  // surface the URL string the caller needs to navigate to next.
  const copied = await page.waitForFunction(
    () => (window as unknown as { __copied: string }).__copied || null,
    null,
    { timeout: 15_000 }
  );
  const url = (await copied.jsonValue()) as string;
  expect(url, "expected an invite URL to land on the clipboard").toMatch(/\/invite\//);
  return url;
}

test.describe("Recipe box invite redemption", () => {
  test("owner shares a box, second user redeems, both see each other", async ({
    signedInPage,
    adminPb,
  }) => {
    // --- Owner: sign in, seed a box, share it ---
    const owner = await signedInPage({ name: "Invite Owner" });

    const box = await adminPb.collection("recipe_boxes").create({
      name: `Shared Box ${Date.now()}`,
      owners: [owner.user.id],
      visibility: "private",
    });
    // Link the box to the owner's user record so it shows up in subscriptions.
    await adminPb.collection("users").update(owner.user.id, {
      recipe_boxes: [box.id],
    });

    // Navigate into the box (refresh first so the box subscription picks
    // up the row we just wrote outside of the live PB session).
    await owner.page.goto(`/boxes/${box.id}`);
    await expect(owner.page.getByRole("heading", { name: box.name })).toBeVisible({
      timeout: 10_000,
    });

    const inviteUrl = await copyInviteLink(owner.page);
    const invitePath = new URL(inviteUrl).pathname;

    // --- Redeemer: sign in fresh, visit the invite URL ---
    const redeemer = await signedInPage({ name: "Invite Redeemer" });
    await redeemer.page.goto(invitePath);

    // The "Invite accepted!" Result screen flashes briefly before the
    // post-success effect navigates to the box detail view. The redirect
    // is the actual user-visible success signal, so assert on URL.
    await expect(redeemer.page).toHaveURL(new RegExp(`/boxes/${box.id}$`), {
      timeout: 15_000,
    });

    // Boxes page: the box now shows up in the redeemer's "Your Boxes" list.
    await redeemer.page.goto("/boxes");
    await expect(redeemer.page.getByText("Your Boxes")).toBeVisible({ timeout: 10_000 });
    await expect(redeemer.page.getByText(box.name)).toBeVisible({ timeout: 15_000 });

    // --- Owner: refresh and verify the redeemer now appears in People ---
    await owner.page.goto(`/boxes/${box.id}`);
    await expect(owner.page.getByRole("heading", { name: box.name })).toBeVisible({
      timeout: 10_000,
    });
    await owner.page.getByRole("button", { name: /sharing/i }).first().click();
    // Menu label is "View people (N)"
    const viewPeople = owner.page.getByText(/view people/i);
    await expect(viewPeople).toBeVisible({ timeout: 5000 });
    await viewPeople.click();
    const peopleModal = owner.page.getByRole("dialog", { name: /people/i });
    await expect(peopleModal).toBeVisible({ timeout: 5000 });
    // Owner is rendered with their real name (they have read access to their
    // own users record). The redeemer may surface as "Unknown user" because
    // `/fn/sharing/owner-info` does a `users.getOne` and the PB default
    // viewRule prevents cross-user reads — that's an app-level data-leak
    // tradeoff, not a sharing bug. The load-bearing assertion is that the
    // Owners count reflects BOTH members (the hook successfully added the
    // redeemer); the menu's "View people (2)" label already proves that, but
    // the modal heading is the canonical source.
    await expect(peopleModal.getByText(owner.user.name)).toBeVisible({ timeout: 5000 });
    await expect(peopleModal.getByText(/Owners \(2\)/)).toBeVisible({ timeout: 5000 });
  });

  test("an already-redeemed invite shows a clear error", async ({
    signedInPage,
    adminPb,
  }) => {
    const owner = await signedInPage({ name: "Double Owner" });

    const box = await adminPb.collection("recipe_boxes").create({
      name: `Once Only ${Date.now()}`,
      owners: [owner.user.id],
      visibility: "private",
    });
    await adminPb.collection("users").update(owner.user.id, {
      recipe_boxes: [box.id],
    });

    await owner.page.goto(`/boxes/${box.id}`);
    await expect(owner.page.getByRole("heading", { name: box.name })).toBeVisible({
      timeout: 10_000,
    });

    const inviteUrl = await copyInviteLink(owner.page);
    const invitePath = new URL(inviteUrl).pathname;

    // First redemption — succeeds. (We assert on the post-redeem redirect,
    // not the briefly-rendered "Invite accepted!" Result screen — see the
    // sibling test for why.)
    const redeemer = await signedInPage({ name: "First Redeemer" });
    await redeemer.page.goto(invitePath);
    await expect(redeemer.page).toHaveURL(new RegExp(`/boxes/${box.id}$`), {
      timeout: 10_000,
    });

    // Second redemption attempt by a different user — same URL, should fail.
    // Stays on the /invite/<code> route showing an error Result (no
    // post-success redirect kicks in).
    const second = await signedInPage({ name: "Second Redeemer" });
    await second.page.goto(invitePath);
    await expect(second.page.getByText(/could not redeem invite/i)).toBeVisible({
      timeout: 10_000,
    });
    // "Go Home" button is present (the user has somewhere to bail to).
    await expect(second.page.getByRole("button", { name: /go home/i })).toBeVisible({
      timeout: 5000,
    });
    // URL did NOT navigate — we should still be sitting on the invite path.
    await expect(second.page).toHaveURL(new RegExp(`/invite/`), { timeout: 5000 });
  });
});
