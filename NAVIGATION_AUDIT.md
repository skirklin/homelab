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

## Bundle 4 — surprising (lower priority) ✅ shipped 2026-05-26

Six per-app commits on main: `3a53412` cross-cutting infra, `241d052` home, `0c3094c` recipes, `430f7db` upkeep+life, `2716f95` shopping+SyncDot, `69c73e5` travel.

### Cross-cutting infra (`3a53412`)
- [x] **#18** `viewport-fit=cover` + `apple-mobile-web-app-capable` + `apple-mobile-web-app-status-bar-style` added to all 9 entry HTMLs. Safe-area-inset padding wired into 7 `index.css` files (travel uses an inline `<style>` block since it has no index.css; homepage merges insets into its existing `padding: 4rem 2rem` via `calc`).
- [x] **#19** SW navigateFallback denylist — **kept as-is**. The current `[/^\/fn\//, /^\/api\//]` is correct: Caddy strips `/fn/*` for the API mount, so backend prefixes (sharing/oauth/mcp/.well-known/health) all sit under `/fn/`. Adding `/sharing/`, `/oauth/`, etc. would break legitimate SPA routes (`/invite/:code`, `/timeline`).

### Home shell (`241d052`)
- [x] **#15** Nav-bar clicks no longer push on re-click of active module — added `isActive(basePath)` early-return guard. Extended to Timeline + Settings buttons.
- [x] **#16** `RedirectToLastApp` validates `lastPath` against a `MODULE_ROOTS` allow-list (`/shopping`, `/recipes`, `/travel`, `/upkeep`, `/tasks`); falls back to `/recipes` on stale/invalid entries.
- [x] `lastPath` write filter — only writes when path matches `MODULE_ROOTS`; transient routes (`/invite/*`, `/recipe/*`, `/settings`, `/timeline`) no longer pollute the stored value.
- Side cleanup: tightened `isActive` helper (was matching `/recipesfoo`).

### Recipes (`0c3094c`)
- [x] **#13** `recordRecentView` gated on `useNavigationType() !== "POP"` — back/forward no longer re-promote in "Recently viewed."
- [x] Breadcrumbs `recipes` (and `boxes`) intermediate segments suppressed via `ROUTE_ONLY_SEGMENTS` filter; rebuilt URLs unaffected.
- [x] WhatsNew `setTimeout(500ms)` auto-open removed. Modal is now dormant — flagged as a follow-up: a Settings menu trigger would re-activate it.

### Upkeep + life (`430f7db`)
- [x] TaskBoard `showSnoozed` → `?snoozed=1` (replace).
- [x] TaskOutliner `focusedId` → `?focus=` (push — back unfocuses). `selectedId` → `?select=` (replace — scrub-style).
- [x] Outliner LAST_LIST persistence parity with Kanban — slug-change effect added.
- [x] **#17** Life dashboard swipe — left/right 20px edges reserved for iOS edge-swipe-back / Android edge-swipe-forward. Day-step gesture still works in the middle.
- Flagged for follow-up (out of scope here):
  - DetailPanel tag updates use full-set replaces (`onUpdate("tags", filter/concat)`) — race-prone for multi-user lists; should route through `tag_task` atomic ops.
  - Header back-button LAST_LIST clearing exists in Kanban but not outliner — inconsistent behavior on revisit.

### Shopping + SyncDot (`2716f95`)
- [x] SyncDot panel — built `useHistoryDismiss(open, setOpen)` hook in `packages/ui/src/sync-status.tsx`. Uses `pushState`/`popstate` with a sentinel state object. Both `SyncStatusBanner` and `SyncDot` use it. Browser back now closes the panel without leaving the page. Cross-app shared code — worth a glance.
- [x] `collapsedCategories` persisted per slug: `shopping:collapsed:<slug>` in localStorage. Survives refresh + list switches.
- [x] **#20** stray `100vh` — already fixed (spec was stale; line 82 already has the `100dvh` fallback).

### Travel (`69c73e5`)
- [x] `LogPicker.tsx` dead code removed (grep confirmed no imports).
- [x] DayView stale `?itin=` — added effect to mirror ItinerarySection's pattern: writes resolved itinerary id back to URL when the requested id is invalid.
- Skipped per audit guidance: `ItinerarySection.tsx:300` route-relative nit, `TripDetail` BackLink history-awareness (both deliberate trade-offs).
- Confirmed missing: **travel trip-proposal UI** — server-side MCP tools exist (`create_trip_proposal` / `resolve_trip_proposal` in `services/api/src/mcp.ts`) but no front-end route, component, or type reference in `apps/travel/`. Feature decision pending — separate conversation.

### Deferred / surfaced for future bundles
- **#12 `<ScrollRestoration/>`** — separate refactor. Requires manual hook implementation (we use `BrowserRouter`, not `createBrowserRouter`). All 8 apps need the wiring. Worth its own bundle.
- **Modals-not-URL-backed policy** — architectural decision (14+ modal sites across recipes/shopping). Deferred until you decide on a policy: URL-backed (bookmarkable, back-to-close) vs in-memory (current).
- **Recipes Filterbox + RecipeTable sort URL-backing** — was in 4c scope but punted to keep the agent's scope tight after an early-termination retry. Mechanical fix, same shape as Bundle 2's `?q=`/`?sort=` patterns.
- **`AddToShoppingButton` over iOS home indicator** — `position: fixed; bottom: 24px` needs `calc(24px + env(safe-area-inset-bottom))`. Bundle 4a guardrails excluded TSX edits; mechanical follow-up.
- **WhatsNew Settings menu trigger** — modal now dormant. Add a "What's new" menu item to re-activate.
- **Travel trip-proposal UI** — confirm intent with user before building.

## Notes

- The cluster of "navigation feels wrong" symptoms ties back to two underlying choices: (1) **absolute vs route-relative `navigate()`** (see `routing.test.tsx` — documented pitfall, still being violated); (2) **state-lives-in-`useState`-not-URL** for tabs, filters, and modal flags. Bundles 1 + 2 attack each.
- The mobile-web layer (Bundle 4 lower items) is largely independent of the routing bundles and could be done in parallel by another agent.
