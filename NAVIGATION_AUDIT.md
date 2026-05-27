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

## Bundle 2 — URL-back tab/filter state ✅ shipped 2026-05-26

Four per-app commits on main: `d971ca8` travel, `b574ca0` shopping, `2455aae` money, `a80a4f9` life. Pattern standardized: URL search params with `setSearchParams(..., { replace: true })` for cheap toggles, push for drilldowns. Defaults aren't written (clean URLs).

### Travel (`d971ca8`)
- [x] Trip-detail tabs → `?tab=`. Validates against `tabItems` keys, defaults to `"itinerary"`. Interop with existing `?view=`/`?itin=` preserved via callback-form `setSearchParams`.
- [x] TripList filters → `?q=` (250ms debounce on search), `?status=`, `?region=`, `?view=`. Enum-typed params validated against `ALL_STATUSES` / `VIEW_MODES` const tuples.
- Out-of-scope flag: search-debounce pattern could be promoted to `useDebouncedSearchParam` in `@kirkl/shared` once a second caller appears.

### Shopping (`b574ca0`)
- [x] View state (list/history/settings) → sub-routes via Option A. `/<slug>/*` splat handles all three views. Browser back works naturally; `goBackToList` falls back to absolute `listPath` with `replace: true` for deep-link refresh; slug rename in Settings keeps user in Settings on new slug.
- Splat-strip from `location.pathname` handles both standalone and embedded mounts uniformly (avoids react-router v6 splat `..` quirks).
- Removed the Bundle 3 `TODO(nav-bundle-2):` marker.

### Money (`2455aae`)
- [x] Chart toggles → URL params with `replace: true` across 5 files (Investments, NetWorthChart, AllocationChart, AllocationOverTime, AccountDetail). Prefixed params to avoid collisions: `?nwRange=`/`?nwView=` (NetWorth), `?alloc=` (Allocation), `?allocGroup=`/`?allocMode=` (AllocationOverTime).
- [x] Spending/Transactions filter pushes → replaces. Extended URL-backing to Transactions `search` (`?q=`), `sortKey` (`?sort=`), `sortDir` (`?dir=`).
- [x] **#6** Travel drilldown → `?trip=`/`?subcat=`. Uses **push** (not replace) for drilldown — back unwinds one level at a time. Breadcrumb-up uses replace.
- [x] Typecheck build gate — already wired (`tsc -b && vite build` in `apps/money/package.json`, run by `infra/docker/app.Dockerfile`). No infra change needed.

### Life (`a80a4f9`)
- [x] **#8** SessionRunner wizard → `?step=N` (URL) + sessionStorage for answers, keyed `life:wizard:<sessionKind>`. Lazy-init at mount restores in-progress work on refresh; Submit clears the draft slot; Back leaves it for re-entry. Defaults not written.
- [x] LifeDashboard `?date` interop — built `dateQuerySuffix` from current `?date` and applied to all 4 nav callsites (mobile menu + desktop buttons for Journal/Insights), since relative `navigate()` drops query strings.
- [x] Journal filters → `?filter=` (whitelist via `parseFilter`), `?q=` for search, `replace: true`. Preserves inherited `?date=`.
- [x] Visualizations: `selectedId` → `?trackable=` (whitelist against `TRACKABLES`); `viewDate` → `?month=YYYY-MM` (regex-validated). Lifted `viewDate` out of `CalendarHeatMap` to make URL the source of truth.

## Bundle 3 — remaining broken ✅ shipped 2026-05-26

Six per-app commits on main: `fa2e022` recipes, `3638b1a` shopping, `b18042a` travel, `888ae65` upkeep+life, `90c907f` money, `c1d2cf8` home shell.

### Recipes (`fa2e022`)
- [x] **#3** `PublicRecipe` basePath — hardcoded to `/recipes` (singular `/recipe/...` mount always lives in the recipes app).
- [x] Recipe deep-link self-fetch — added, mirrors `Box.tsx` pattern.
- [x] Recipes `Header.tsx:42` — dropdown "Manage Boxes" now uses `${basePath}/boxes`.
- [x] `SaveRecipe.tsx:51` — post-save navigate uses `{ replace: true }`.
- [x] `NewRecipe.tsx` initial draft URL pushed with `{ replace: true }`. **NewBox.tsx** had no nav to fix — its `NewBoxModal` opens a modal, doesn't navigate.
- [x] `JoinBox.tsx` Cancel/Go Home — uses `${basePath || "/"}` with replace.
- [x] `InviteRedeem.tsx:97` — dropped the 1s setTimeout race; added a cancelled guard.
- [x] `RecipesRoutes.tsx:48` — removed duplicate `/boxes/:boxId/recipes` route. Grep confirmed no internal references.

### Shopping (`3638b1a`)
- [x] `Header.tsx:109-112` — header back drops the `LAST_LIST` strip, uses `?pick=true` to reach the picker (consistent with Bundle 1's not-found button).
- [x] `ListSettings.tsx:239` — `TODO(nav-bundle-2):` comment added for the refresh-loses-Settings-view issue. No functional change.
- [x] **Shopping module.tsx:34 slug collision** — added `RESERVED_SLUGS` set + `sanitizeSlug()` helper in `packages/ui/src/ListManagement.tsx`, exported from `@kirkl/shared`. Reserved: `join`, `login`, `auth`, `settings`, `new`. Collisions get `-1` appended. Side effect: aligned three previously-duplicated sanitizers, so rename input "hello world!" now produces `hello-world` (was `hello-world-`).

### Travel (`b18042a`)
- [x] `InviteRedeem.tsx:81` — error-path navigate uses `{ replace: true }`.
- [x] `DayView.tsx:293` — `goToDay` prev/next uses `{ relative: "path", replace: true }`; arrow-scrubbing no longer pollutes history.
- [x] `ItinerarySection.tsx:286` — added effect that writes resolved itinerary id back to `?itin=` when it differs (also writes on first load when no param is set — gives shareable URLs).

### Upkeep + Life (`888ae65`)
- [x] **Upkeep Header.tsx:50 shareUrl** — derives module base from `location.pathname` (strips trailing `/<slug>`). Works for standalone (`upkeep.kirkl.in`), `/upkeep/*` embed, and `/tasks/*` embed.
- [x] **#7** Tasks routes — added `/join/:listId` route; Bundle 1's JoinList fix routes correctly from `/tasks/join/:id` → `/tasks/<slug>`.
- [x] Upkeep `*` catch-all — added to both `UpkeepRoutes` and `TasksRoutes`.
- [x] Life `SessionRunner` — three sites swapped from `navigate("/")` to `navigate("..")` (no-op for current standalone deploy, safe if re-embedded).
- [x] Life `LifeDashboard` param scrub — swapped raw `history.replaceState` for `setSearchParams({ replace: true })`. Subtle fix: required splitting the messaging-init effect from the param-scrub effect so URL changes don't re-register FCM listeners.

### Money (`90c907f`)
- [x] `App.tsx:80` catch-all — added `<Route path="*" element={<Navigate to="/" replace />} />`.
- [x] `App.tsx:64` BrowserRouter — moved outside the loading gate (split into `App` wrapping `AppContent`).
- [x] `PerformanceVsBenchmark.tsx:22` — made controlled; parent (`Investments.tsx`) owns the canonical `timeRange`.
- [x] `PersonDetail.tsx:43` + `InstitutionDetail.tsx:43` — back-links now use `navigate(-1)` with `/accounts` fallback on deep-link refresh. Label changed from "All Accounts" → "Back" since `-1` may not return there.
- (Side note: money's typecheck baseline is now clean — could wire `tsc -b` into the build gate as a follow-up.)

### Home shell (`c1d2cf8`)
- [x] `App.tsx:58` — replaced silent catch-all `<Navigate>` with inline `<NotFound />`: shows offending path, "Go home" button (`navigate("/", { replace: true })`), shortcut links to each module root.
- [x] `Shell.tsx:149-151` — sign-out now uses `navigate("/", { replace: true })`.

### Deferred to Bundle 2 (URL-state structural)
- [ ] **Travel TripList.tsx:354-357** — `search`, `statusFilter`, `regionFilter`, `view` not URL-backed.
- [ ] **Life Journal/Visualizations** — filter/search/selectedId/viewDate all in `useState`.

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
