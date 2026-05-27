# Navigation audit — 2026-05-26

Multi-agent audit findings. Status legend: `[ ]` open, `[x]` fixed, `[~]` partial / needs follow-up.

Severities: **broken** = produces wrong behavior, **surprising** = violates SPA convention or feels off, **nit** = small/cosmetic.

## Bundle 1 — programmatic-nav semantics ✅ shipped 2026-05-26

Commits `53c3f3c..eb8c597` on main.

- [x] **#1 broken** — `JoinList.handleJoin` uses absolute `/` prefix in `packages/ui/src/ListManagement.tsx:523`. Fixed in `53c3f3c` by deriving module base from `useLocation().pathname.replace(/\/join\/[^/]*$/, "")` and appending the slug with `replace: true`. Regression test added in `4b9e6b2`.
- [x] **#2 broken** — Top-level `/invite/:code` in `apps/home/app/src/App.tsx:31-34` unconditionally forwarded to recipes. Fixed in `9ce3f39`: added public `GET /sharing/invite-info/:code` endpoint + `getInviteInfo()` helper; `InviteRedirect` now reads `target_module` and forwards correctly. Unknown invites fall through to recipes' existing error UI.
- [x] **#4 broken** — "Go to My Lists" → ListPicker auto-redirect loop. Fixed in `816d0b9`: shopping + upkeep buttons now navigate with `?pick=true` (existing escape hatch that ListPicker's effect respects).
- [x] **#5 broken** — Delete handlers push history (back returns to 404). Fixed in `4c68bde` across all four sites; money switched from `window.location.href` to `useNavigate(..., { replace: true })`.
- [x] **#11 surprising** — `navigate(-1)` Cancel buttons exited the app on deep-link refresh. Fixed in `b637951` (initial pass: `navigate("..", { replace: true })`) and tightened in `eb8c597`: ActivityForm Cancel now `navigate(\`../${tripId}\`, { replace: true })` (matches Save), TripForm uses `{ relative: "path" }` so it works for both `/travel/new` and `/travel/:tripId/edit`.

Notes from the work:
- Fix 2 adds a new public unauthenticated endpoint. Returns only `target_type`, `target_module`, `redeemed` — no invite contents or target IDs. Symmetric with the existing public `list-info` endpoint. Worth a security re-glance if anything else gets layered on it.
- `apps/recipes/app/src/routes/InviteRedeem.tsx:100` has a `setTimeout(redirectToTarget, 1000)` — race between auto-redirect and user pressing back. Bundle 3 will pick it up.

## Bundle 2 — URL-back tab/filter state (structural)

Choose-one-policy work. Pattern to standardize on: URL search params with `setSearchParams(..., { replace: true })` for cheap toggles (existing pattern at [apps/travel/app/src/components/ItinerarySection.tsx:283](apps/travel/app/src/components/ItinerarySection.tsx#L283)).

- [ ] **#9 surprising — travel trip-detail tabs** are React state at [apps/travel/app/src/components/TripDetail.tsx:189](apps/travel/app/src/components/TripDetail.tsx#L189). Prep tab unshareable. Move to `?tab=`.
- [ ] **#9 surprising — shopping view** (`list | history | settings`) at [apps/shopping/app/src/components/ShoppingList.tsx:134](apps/shopping/app/src/components/ShoppingList.tsx#L134). Android back exits the module. Move to sub-route or `?view=`.
- [ ] **#9 surprising — money chart toggles**: time-range / view-mode in `useState` across [Investments.tsx:74-75](apps/money/src/pages/Investments.tsx#L74), [NetWorthChart.tsx:28-29](apps/money/src/components/NetWorthChart.tsx#L28), [AllocationChart.tsx:26](apps/money/src/components/AllocationChart.tsx#L26), [AllocationOverTime.tsx:28-29](apps/money/src/components/AllocationOverTime.tsx#L28), [AccountDetail.tsx:34](apps/money/src/pages/AccountDetail.tsx#L34), [PerformanceVsBenchmark.tsx:22](apps/money/src/components/PerformanceVsBenchmark.tsx#L22) (also has dual source of truth bug with parent).
- [ ] **#10 surprising — money filter state inconsistency**. Spending/Transactions are URL-backed but `setSearchParams` defaults to push, polluting history per filter click. Sites: [Spending.tsx:24-78](apps/money/src/pages/Spending.tsx#L24-L78), [Transactions.tsx:103](apps/money/src/pages/Transactions.tsx#L103). Use `{ replace: true }`. Also extend URL-backing to `search`/`sort` at [Transactions.tsx:28-30](apps/money/src/pages/Transactions.tsx#L28-L30).
- [ ] **#6 broken — money Travel drilldown** is React state at [apps/money/src/pages/Travel.tsx:9-10](apps/money/src/pages/Travel.tsx#L9-L10). Back exits the route.
- [ ] **#8 broken — life wizard state** is `useState` at [apps/life/app/src/components/SessionRunner.tsx:119,151](apps/life/app/src/components/SessionRunner.tsx#L119). Refresh mid-wizard loses progress. Move step + answers to URL or sessionStorage.

## Bundle 3 — remaining broken

- [ ] **#3 broken** — `PublicRecipe` basePath wrong for singular `/recipe/...` route. [apps/recipes/app/src/routes/PublicRecipe.tsx:175,180,282](apps/recipes/app/src/routes/PublicRecipe.tsx#L175). Cross-recipe `[[recipe:…]]` links render unprefixed.
- [ ] **#7 broken** — Tasks routes have no `/join/:listId`. [apps/upkeep/app/src/module.tsx:42-47](apps/upkeep/app/src/module.tsx#L42-L47). Outliner-only users can't join shared lists from Kanban users.
- [ ] **Recipe deep-link**: no self-fetch fallback at [apps/recipes/app/src/routes/Recipe.tsx:16](apps/recipes/app/src/routes/Recipe.tsx#L16) (Box does have one). Deep-link to unsubscribed recipe shows "Unable to find recipe."
- [ ] **Recipes Header.tsx:42** — embedded "Manage Boxes" uses relative `navigate("boxes")`, resolves wrong from deep routes.
- [ ] **Recipes SaveRecipe.tsx:51** — pushes to a `uniqueId=` URL that no longer renders; back shows "Unable to find recipe."
- [ ] **Recipes NewBox/NewRecipe.tsx:37** — temp `uniqueId=` URL enters history before save.
- [ ] **Recipes JoinBox.tsx:137,162** — Cancel uses relative `navigate(".")`.
- [ ] **Recipes PublicRecipe.tsx:180,282** — sign-in hard-codes `/recipes/...`.
- [ ] **Recipes InviteRedeem.tsx:97** — `setTimeout(... 1000)` race with user backing out.
- [ ] **Recipes RecipesRoutes.tsx:48** — `/boxes/:boxId/recipes` duplicates `/boxes/:boxId` route.
- [ ] **Shopping Header.tsx:109-112** — strips `LAST_LIST` on back; combined with auto-redirect creates the loop in #4.
- [ ] **Shopping ListSettings.tsx:239** — slug rename inside Settings view: `replace` updates URL but leaves user inside a now-orphaned view.
- [ ] **Shopping module.tsx:34** — `/:slug` collides with `/join/:listId` if a list is slug'd `"join"`. Saved by route order today, but [ListManagement.tsx:252](packages/ui/src/ListManagement.tsx#L252) slug sanitizer should blacklist `"join"`.
- [ ] **Travel TripList.tsx:354-357** — `search`, `statusFilter`, `regionFilter`, `view` not URL-backed; lost on refresh, reset on back.
- [ ] **Travel InviteRedeem.tsx:81** — error path pushes instead of replacing; back re-runs the failing redeem.
- [ ] **Travel DayView.tsx:293** — `goToDay` arrow clicks each push history; 10 clicks = 10 entries.
- [ ] **Travel ItinerarySection.tsx:286** — itinerary `Select` shows resolved id while URL holds stale id (drift).
- [ ] **Upkeep Header.tsx shareUrl** — `${origin}/join/${listId}` (no app prefix); shared link 404s when copied from `kirkl.in/upkeep/...`. [apps/upkeep/app/src/components/Header.tsx:50](apps/upkeep/app/src/components/Header.tsx#L50)
- [ ] **Upkeep module.tsx** — neither `UpkeepRoutes` nor `TasksRoutes` has a `*` fallback inside the embedded `<Routes>`. `/upkeep/nonexistent` renders blank.
- [ ] **Life SessionRunner absolute navigate** — uses `navigate("/")` for back/cancel/done. Latent breakage if life is ever re-embedded. [SessionRunner.tsx:130,138,168](apps/life/app/src/components/SessionRunner.tsx#L130)
- [ ] **Life LifeDashboard.tsx:580-606** — raw `window.history.replaceState` for param scrub bypasses react-router's URL store. Switch to `setSearchParams({ replace: true })`.
- [ ] **Life Journal/Visualizations** — filter/search/selectedId/viewDate all in `useState`; can't share or refresh. [Journal.tsx:247-248](apps/life/app/src/components/Journal.tsx#L247-L248), [Visualizations.tsx:277,437](apps/life/app/src/components/Visualizations.tsx#L277).
- [ ] **Money App.tsx:80** — no catch-all `<Route path="*">`. Unknown URLs render empty `<main>`.
- [ ] **Money App.tsx:64** — `BrowserRouter` mounted inside the loading gate. Hard refresh shows loading with no nav; clicks before fetch resolves are dropped.
- [ ] **Money PerformanceVsBenchmark.tsx:22** — owns its own `timeRange` state AND notifies parent; two sources of truth.
- [ ] **Money PersonDetail.tsx:43, InstitutionDetail.tsx:43** — back-link hardcoded to `/accounts` ignores actual referrer.
- [ ] **Home App.tsx:58** — catch-all `<Navigate to="/" replace />` silently swallows real routing bugs. Consider a real 404.
- [ ] **Home Shell.tsx:149-151** — sign-out pushes instead of replacing; back re-enters cached authenticated UI.

## Bundle 4 — surprising (lower priority)

- [ ] **#12** — No `<ScrollRestoration/>` anywhere across 8 `BrowserRouter` instances. Back always lands at top.
- [ ] **#13 Recipes Recipe.tsx:20** — `recordRecentView` re-fires on back/forward, re-promoting the recipe in "Recently viewed."
- [ ] **#14 Recipes RecipesRoutes.tsx:48** — duplicate route fragments history (see Bundle 3 too).
- [ ] **#15 Home Shell.tsx:143-146** — nav-bar push (every header click adds history entry, even re-clicking active module).
- [ ] **#16 Home RedirectToLastApp** — `lastPath` not validated; can point at deleted route (e.g. stale `/life/...` after May 20 extraction). PWA cold-launches to 404 with no back. [apps/home/app/src/App.tsx:22-26](apps/home/app/src/App.tsx#L22-L26)
- [ ] **Modals not URL-backed** (consistency note — pattern, not single bug): recipes "I made it!" / Import / PickBox / NewBox / AddToShopping / BatchEnrichment / Owners / WhatsNew; shopping Share / Rename / Slug / RenameCategory; SyncDot panel. Decide policy: URL-backed modals (good for bookmarking, back-to-close) vs in-memory (current default).
- [ ] **Filter state not URL-backed** (consistency note): recipes Filterbox + table sort; travel TripList; many money pages; life Journal/Visualizations.
- [ ] **Recipes Breadcrumbs.tsx:53** — clickable "recipes" segment is a real route but a confusing crumb.
- [ ] **Recipes RecipeCard.tsx:103** + similar — modal local-state pattern (see modal consistency note).
- [ ] **Recipes Filterbox.tsx:84** — filter not URL-backed (see filter consistency note).
- [ ] **Recipes WhatsNew.tsx:40** — auto-opens via `setTimeout(500ms)` with no URL signal; can't be dismissed via browser back.
- [ ] **Shopping SyncDot panel** — local state, browser back exits app. [packages/ui/src/sync-status.tsx:303,372](packages/ui/src/sync-status.tsx#L303)
- [ ] **Shopping ShoppingList.tsx:135** — `collapsedCategories` not persisted across slug changes.
- [ ] **Travel ItinerarySection.tsx:300** — relies on default route-relative resolution; fragile if route tree changes.
- [ ] **Travel DayView.tsx:250-273** — stale `?itin=` from deleted itinerary doesn't gracefully fall back.
- [ ] **Travel TripDetail.tsx:225-263** — BackLink `navigate("..")` is fine but worth noting it's not history-aware.
- [ ] **Upkeep TaskBoard.tsx:113** — `showSnoozed` toggle not URL-backed; refresh collapses Snoozed drawer.
- [ ] **Upkeep TaskOutliner.tsx:74-75** — `focusedId`/`selectedId` `useState`; refresh loses detail-pane selection.
- [ ] **Outliner + Kanban tag filter** — no URL surface at all on either view (despite brief expecting one).
- [ ] **Outliner persistence inconsistency** — Kanban persists `LAST_LIST` to localStorage; outliner does not.
- [ ] **Home Shell.tsx:129-138** — `lastPath` written on every pathname change including transient deep routes (e.g. mid-scrape).
- [ ] **Mobile #17** — Life dashboard horizontal swipe (50px threshold, 100% width) competes with iOS edge-swipe-back. [LifeDashboard.tsx:397-419](apps/life/app/src/components/LifeDashboard.tsx#L397-L419)
- [ ] **Mobile #18** — No `viewport-fit=cover` / no `safe-area-inset` anywhere across 8 apps. PWA notched-iPhone overlap.
- [ ] **Mobile #19** — SW `navigateFallback: /index.html` has no denylist for deleted routes. After a deploy that removes routes, the SW serves the cached shell so URL "works" but renders nothing useful. [packages/vite-preset/src/index.mjs:57](packages/vite-preset/src/index.mjs#L57)
- [ ] **Mobile #20** — Stray bare `100vh` at [apps/shopping/app/src/components/ShoppingList.tsx:87](apps/shopping/app/src/components/ShoppingList.tsx#L87). May 20 `100dvh` sweep missed it.
- [ ] **Mobile** — No `apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style` meta in any index.html. Legacy iOS add-to-home installs don't get full-screen.
- [ ] **Travel LogPicker.tsx** — dead code, never imported. Cleanup candidate.
- [ ] **Travel trip-proposal UI missing** — server-side MCP tools exist but no front-end route. Confirm intent (backend-only?) before treating as a bug.

## Notes

- The cluster of "navigation feels wrong" symptoms ties back to two underlying choices: (1) **absolute vs route-relative `navigate()`** (see `routing.test.tsx` — documented pitfall, still being violated); (2) **state-lives-in-`useState`-not-URL** for tabs, filters, and modal flags. Bundles 1 + 2 attack each.
- The mobile-web layer (Bundle 4 lower items) is largely independent of the routing bundles and could be done in parallel by another agent.
