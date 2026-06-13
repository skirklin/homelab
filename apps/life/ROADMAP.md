# Life App Roadmap

Living plan for evolving the life app from a habit-tracker into a real reflection + intention surface. Updated 2026-05-24.

## Vision

> A low-fuss space for tracking habits, sleep, and reflection — built because every third-party ADHD app is noisy, shallow, over-gamified, and constantly upselling. The goal is not autopilot; the goal is to spend more time on the things you actually want to.

**Success metric:** feeling more present and connected to my choices, less on autopilot. Concrete habits to support: consistent exercise, Chinese language practice, reading, cooking/baking.

## Design principles

1. **Intrinsic motivation > extrinsic.** Streaks and honest historical reflection, not badges/levels/XP. The user IS the customer; no synthetic engagement.
2. **Reflection compounds.** The biggest payoff isn't writing — it's re-reading. Every design decision should make re-reading feel rich.
3. **Invitations, not nudges.** Soft prompts like "thinking back on today?" beat "time to do your evening session." Daily push limit: one morning + one evening.
4. **Be honest.** No streak freezes, no fake progress. No synthetic milestones.
5. **Daily loop friction ≤30 seconds.** New features that lengthen the morning/evening flow are anti-patterns. Reading + reflection features are separate routes.
6. **Use Claude as the analysis layer.** Don't build static ML/correlation views — let a model look at the data ad hoc. Distinguishing capability vs any third-party app.

## What exists today

- Standalone app at `life.kirkl.in` (unhosted from home shell)
- Manifest-as-code (`apps/life/app/src/manifest.ts`): 8 widgets (medical/consumables/bio counter-groups, floss counter, sleep/exercise/symptoms/work combos)
- Morning + evening session wizards (`/morning`, `/evening`) — each writes a `life_events` row with `subject_id = "<id>_session"` and `data: { promptId: value, ... }`
- Random sampling (mood/content rating questions, configurable schedule)
- Per-user morning/evening reminder times (configurable in Settings)
- Insights/Visualizations page
- Date navigation + swipe
- CSV/JSON export
- Single-owner data model (`life_logs.owner`, UNIQUE constraint)

## Phases

### Phase 1: Daily loop polish (in flight)

1. **`/journal` route** — reverse-chrono browse of morning/evening entries with filter chips + search + "on this day" strip
2. **Streak counter + GitHub-style year heatmap** on dashboard
3. **Context-aware dashboard** — morning session card prominent before noon, evening after 5pm, both quiet after 10pm
4. **Weekly review session** — Sunday evening, same SessionRunner wizard, prompts focused on highlights/lows/next-week intention

### Phase 2: Claude as analysis layer (next big bet)

This is the most distinguishing feature.

1. **`claude_observations` PB collection** — schema: `{timestamp, content, period: "weekly"|"monthly"|"adhoc", data_window_start, data_window_end, related_event_ids[]}`
2. **`POST /api/observations/generate`** endpoint — bundles up `life_events`, `cooking_log`, `task_events`, etc. for the requested window, calls Anthropic API with a tight system prompt ("thoughtful friend, 2-3 honest observations, one question, no fluff"), persists the result
3. **Scheduled weekly observer routine** — cron Sunday afternoon, fires the endpoint with the past week's window
4. **`/observations` view** in life app — chronological feed of past observations
5. **"Ask Claude about my week/month"** button on the journal route — same endpoint, user-triggered
6. **Soft push notification** when a new observation lands

### Phase 3: Habit widget expansion

Mapped to the user's stated focus areas:
1. **Chinese practice** — combo widget (minutes + mode: vocab/listening/reading/writing/speaking)
2. **Reading** — combo widget (minutes + current book text field) OR separate "currently reading" widget + session counter
3. **Cooking/baking** — surface the recipes app's `cooking_log` as a virtual widget in the life dashboard (read-only "you cooked N times this week"). No new data, just a view that cross-pollinates.
4. **Exercise** — already exists. Defer lifts/reps/weights detail unless explicitly wanted. The combo widget (hours + intensity) is the right friction shape.

### Phase 4: Friction reduction

1. **Voice capture** — browser SpeechRecognition API → text → `quick_capture` event. One button on dashboard.
2. **Journey app import** — one-shot script to ingest historical journal entries from third-party app "Journey." Need: export format (JSON ideal), entry count, whether photos are wanted. Lands as `life_events` rows with `subject_id: "freeform_journal"` (not `morning_session`/`evening_session` — separate from prompted sessions).

### Phase 5: Opt-in expansions (someday)

1. **Wearable integration** — pull sleep duration + HRV from Apple Health / Google Fit. Auto-populates sleep widget. Risky to depend on; user not currently wearing one. Worth it if/when they re-adopt a device.
2. **Location tagging** — browser geo (opt-in) tags entries with location. Then Claude observations can spot "your mood is higher when not in San Francisco" patterns.
3. **Yearly themes** — set a focus once per year; morning prompts rotate around it; end-of-year recap reviews against it.
4. **Symptom tracking dashboard** — dedicated view with trend lines, notes per entry, export-to-PDF (e.g., to share with a doctor or PT someday).

## UI improvements (punch list)

Small, concrete fixes outside the phased plan. Pull from this list when there's appetite for a polish pass.

1. **URL-sync the selected date.** Dashboard's `selectedDate` lives only in `useState` ([LifeDashboard.tsx:249](app/src/components/LifeDashboard.tsx#L249)), so refresh always snaps to today and there's no back-button to yesterday. Encode as `?date=YYYY-MM-DD` (or `/day/YYYY-MM-DD`), keep "today" as the no-param default so existing bookmarks still work.
2. **Edit recorded entries.** Delete already exists — when a tracker has logged data today the value badge opens [EntriesPopover](app/src/components/EntriesPopover.tsx) with a per-entry delete button, surfaced from [EventLogger.tsx:381-389](app/src/components/EventLogger.tsx#L381-L389). The gaps are (a) discoverability — the badge doesn't look tappable — and (b) edit: change the timestamp on a misfired log, or correct a value. Worth adding inline edit in the same popover.
3. **Tighten the grid.** Dashboard feels very airy on desktop. Audit gaps + card padding (currently `var(--space-sm)` between cards, `var(--space-lg) var(--space-md)` on primary cards). Consider denser breakpoint targets and a "compact mode" toggle that goes one step beyond the existing `widgetSize: compact`.

## Anti-patterns to actively avoid

- Badges/achievements for arbitrary milestones ("100 sessions logged!")
- Comparing to other users
- Streak freezes / cheats — either the streak is real or it isn't
- "Level up" mechanics / RPG framing
- Aggressive notifications — daily push limit is morning + evening
- Forcing long forms; the 3-prompt session is already at the right length
- Hard-coding "insights" instead of letting Claude analyze ad hoc

## Open questions

- **Journey export format / entry count / photos.** User says they have a backlog; haven't been able to export successfully yet. Resolve before Phase 4.
- **Claude observer cadence.** Weekly is the proposed default; daily feels too aggressive, monthly too sparse. Worth iterating once the v1 ships.
- **Where does the observer's prompt live?** In the api service, in a versioned file, or in a code constant. Probably code constant for now, with a path to "user-customizable system prompt" later if it matters.
- **Should observations get a push notification, or just live silently in the app?** Lean: silent + a soft "new observation" dot/badge on the dashboard, not a push.
- **Cross-module data in observations.** Money spending data — relevant to surface to the observer, or out of scope? Probably opt-in per-window.

## Reference

- Manifest: [apps/life/app/src/manifest.ts](app/src/manifest.ts)
- SessionRunner: [apps/life/app/src/components/SessionRunner.tsx](app/src/components/SessionRunner.tsx)
- Notification scheduler: [services/api/src/lib/notifications/life.ts](../../services/api/src/lib/notifications/life.ts)
- Backend interface: [packages/backend/src/interfaces/life.ts](../../packages/backend/src/interfaces/life.ts)
- PB impl: [packages/backend/src/pocketbase/life.ts](../../packages/backend/src/pocketbase/life.ts)

---

# Multi-user + per-user trackables (decided design + implementation plan)

> Status: **planned, not started.** Added 2026-06-01. This is the spec of record
> for letting a second, fully-independent user use the life app with zero data
> crossover, and for making *trackables* user-customizable. **Sessions stay
> code-defined.** Do not re-litigate the design below — it is settled with the
> user. The phase plan and the renderer-sizing finding are the engineering work.

## Goal & key insight

Let a second, fully-independent user use the life app with **zero data
crossover**, AND make *what you track* customizable per user. The enabling
observation: `life_events` is **already** a generic typed-entry store
(`{subject_id, timestamp, entries: (number|text|bool)[], labels}`), and per-user
data is **already** isolated by the `owner = @request.auth.id` collection rules
(single-owner since migration 0028, forward pointer dropped in 0029).
Customization is therefore a **config/presentation problem, not a data
migration**. The event shape does not change. No code may reference any specific
trackable id (the open/freeform surface).

## Settled design

### 1. Multi-user isolation — already enforced at the PB rule level

Two independent tenants. **No `owners[]`, no invites, no shared records.** Only
mechanical gaps to close:

- **Signup path** — the production sign-in is **Google OAuth only**
  ([Auth.tsx](app/src/components/Auth.tsx): `authWithOAuth2({ provider: "google" })`;
  the email/password `create()` branch is `import.meta.env.DEV`-gated). A second
  user signs in with their own Google account, and PB auto-creates their `users`
  row on first OAuth2 — *provided* the `users` collection has Google OAuth2
  enabled with open (non-allowlisted) self-registration. This is a **PB-config
  verification**, not a code change. Confirm in the PB admin (or a migration that
  asserts the auth-collection OAuth2 + `createRule`) before declaring P0 done.
- **Reminder cron** — see the finding below: it **already** iterates all logs and
  resolves each owner's own timezone. The only residue is the *random-sampling*
  path using a global tz; the session reminders are already correct.

### 2. Trackables → per-user, generic, data-defined

- Add a `manifest` JSON column to `life_logs` holding `{ trackables[] }`.
  **Sessions are NOT in here.**
- New generic shape:
  ```ts
  type Trackable = {
    id: string;          // IMMUTABLE — becomes subject_id; history join key
    label: string;
    group?: string;
    hidden?: boolean;
    fields: TypedField[];
    pinned?: Payload[];  // manual quick-action favorites (see §4)
  };
  type TypedField = {
    key: string;         // IMMUTABLE — entry name / label key; history join key
    type: "number" | "rating" | "text" | "category" | "bool";
    label?: string;
    unit?: string;       // for number
    scale?: number;      // for rating (default 5)
    options?: string[];  // for category
    defaultValue?: number | string | boolean;
    optional?: boolean;
  };
  ```
- **Mapping rule:** measurement fields (`number`/`rating`/`text`/`bool`) →
  `life_events.entries[]` (one entry per field, `name = field.key`); `category`
  fields → `life_events.labels` (`labels[field.key] = value`).
- **`id` and `field.key` are IMMUTABLE** (they are the join keys that link
  history). Everything else (label, group, unit, options, defaults, order,
  hidden, pins) is freely editable.
- `life_events` shape is **unchanged**.

### 3. Sessions → UNCHANGED

`morning` / `evening` / `weekly_review` stay a **closed, code-defined set** in
[manifest.ts](app/src/manifest.ts) + [SessionRunner.tsx](app/src/components/SessionRunner.tsx).
The scaffold + behaviors (MorningUpkeepHeader todo check, intention threading via
`findMorningIntention`/`contextKey`, weekly-intention banner, completion chart,
notification scheduler) stay in code and read each authed user's own data, so
they are **already per-user-correct and leak nothing**. Sessions are **not**
going into the per-user manifest. `answersToEntries` in SessionRunner is
self-contained and does **not** use `primaryEntryName`, so the trackable refactor
does not touch it. Prompt-content customization is explicitly **deferred**.

### 4. Quick entry → replaces hardcoded presets

- A quick-action is a replayable `{ entries[], labels{} }` payload.
- **Hybrid:** `trackable.pinned[]` (manual favorites, stable, shown first) +
  **runtime FRECENCY** over `life_events` history (learned, fills remaining chip
  slots, **zero storage**). Frecency suits discrete repeated values
  (doses/counts/oz/categories); continuous values (sleep minutes) naturally
  won't surface stable chips — that is correct/intended.
- Add a **GLOBAL cross-trackable quick-log row** on the dashboard (most-frecent
  actions + pins across all trackables, one tap).
- **DELETE** the PWA `shortcuts[]` derivation in
  [vite.config.ts](app/vite.config.ts) and the `presets` field on `Trackable`.
  The `/quick/:id?v=` route + [QuickLog.tsx](app/src/components/QuickLog.tsx) go
  dead once shortcuts are removed — **verified safe** (see open questions).

### 5. Seeding & migration

- **New users:** a MINIMAL type-demo starter set copied into the manifest on
  first `getOrCreateLog` — one trackable per field type, generically named (e.g.
  Water [number/oz], Mood [rating], Note [text], Movement [category + number],
  Floss [bool/count]). **Not** the current personal 17.
- **Existing log (scott's):** a PB migration backfills today's hardcoded
  `TRACKABLES` → generic single-field trackables **1:1, preserving ids**.
  (The backfill itself didn't merge anything; in 2026-06 sleep_quality WAS
  then deliberately folded into sleep — and exercise/focus split into
  per-thing subjects — by the one-shot history rewrites under
  [services/scripts/historical/](../../services/scripts/historical/):
  `merge-sleep-quality.ts` + `split-category-subjects.ts`.)
- `TRACKABLES` in [trackables.ts](app/src/trackables.ts) **stops being the
  runtime source**; it survives only as the default-template module / seed for
  the backfill.

### 6. Editing surface — MCP-first

Add tools in [services/api/src/mcp.ts](../../services/api/src/mcp.ts):
`list_life_trackables`, `add_life_trackable`, `update_life_trackable`,
`remove_life_trackable`, `reorder_life_trackables`, plus pin add/remove.
**Removal is manifest-only** — never deletes events; events with that
`subject_id` persist and **re-link if the trackable is re-added with the same
id**. A thin in-app editor is a LATER phase.

---

## Renderer-sizing finding (the P2 lift): **consolidation, not a rewrite**

The estimate hinged on how special-cased the input/render path is. After reading
[EventLogger.tsx](app/src/components/EventLogger.tsx),
[Visualizations.tsx](app/src/components/Visualizations.tsx),
[format.ts](app/src/lib/format.ts), and [LifeDashboard.tsx](app/src/components/LifeDashboard.tsx):
**EventLogger is already ~90% config-driven off a single-primary-field model.**
The work is to generalize "one implicit primary field + optional
intensity/notes/category" into an explicit `fields[]` loop — a refactor, not a
rebuild.

**Already generic (no per-widget branching):**
- The whole card chrome, value badge, entries popover, day filtering, and submit
  plumbing read `trackable.unit` / `defaultValue` / `categories` / `hasIntensity`
  / `hasNotes` / `presets`. There are **no `if (trackable.id === ...)` branches**
  anywhere in EventLogger.
- Mode detection is purely shape-based: `isOneTap()` (ct + default 1 + no
  extras), `isRatingShaped()` (`unit === "rating"`), duration-vs-number input
  toggle (`unit === "min"` + `defaultValue >= 60`).
- Field editors are already extracted primitives
  ([EntryFields.tsx](app/src/components/EntryFields.tsx): `NumberFieldEditor`,
  `DurationFieldEditor`, `TextFieldEditor`) shared by add + edit surfaces.
- **Visualizations is fully generic** — `getMonthData`/`getLast30DaysData`/
  `getWeeklyData`/`CalendarHeatMap`/`TrendChart` all key off `trackable.unit`,
  `aggregationFor(unit)`, and `primaryEntryName(id)`. **No chart hardcodes any
  trackable id or unit.** It needs zero structural change for new field types —
  only the `primaryEntryName` swap below.

**The one real coupling — `primaryEntryName(subjectId)` ([format.ts:149](app/src/lib/format.ts#L149)):**
a hardcoded `switch` mapping subject_id → primary entry name (`vyvanse`→`"dose"`,
`alcohol`→`"drinks"`, `sleep`→`"duration"`, `mood`→`"rating"`, default→`"count"`).
EventLogger, Visualizations, and QuickLog all call it to know which entry carries
the trackable's main number. Under the generic model the entry name **is**
`field.key`, so:
- New per-user trackables write `entries[].name = field.key` and aggregate by
  reading the same key from the manifest. The `switch` is **not consulted** for
  new trackables.
- The `switch` survives only as a **read-time compatibility shim for scott's
  pre-backfill history** — OR, cleaner, the P1 backfill migration sets each
  backfilled trackable's `fields[0].key` to match the *existing* historical entry
  name (`"dose"`, `"duration"`, etc.), and `primaryEntryName` is deleted
  outright. **Prefer the latter** — it removes the only id-coupled code in the app.

**What P2 actually changes:**
1. Replace the implicit single-primary model in EventLogger with a `fields.map()`
   that renders the right `EntryField*` per `field.type` (the three editors
   already exist; add a `category` chip-group renderer — already present inline
   for `trackable.categories`, just rebind to a `category` field; and a `bool`
   toggle — trivial). One-tap / rating-shaped fast paths become "single
   non-optional field of type ct-default-1 / rating" — same heuristics, read off
   `fields[]`.
2. Build aggregation/display off `field` (unit, scale) instead of the
   `primaryEntryName` switch + `trackable.unit`.
3. Swap the dashboard + insights read path from the hardcoded `TRACKABLES` import
   to `state.log.manifest.trackables`.

**Sizing: medium.** EventLogger is the bulk; it is a focused rewrite of one
component's render body (~250 lines), not new architecture. Visualizations is a
one-line read-path swap. The riskiest correctness surface is the
`primaryEntryName` removal vs scott's history — covered by the P1 backfill
keying `fields[0].key` to historical entry names (test-first against a seeded PB).

---

## Phase plan

Ordering is dependency-driven: isolation first (smallest, unblocks a second
user immediately), then the data model, then the renderer, then quick-entry +
cleanups, then MCP, then the in-app editor.

### P0 — Isolation gaps (small)

**Files:** [services/api/src/lib/notifications/life.ts](../../services/api/src/lib/notifications/life.ts)
(random-sampling tz only), PB `users` auth-collection config (verify, possibly a
migration assertion).

- **Verify** Google OAuth2 self-registration is open on the `users` collection so
  a second Google account can sign in and auto-provision. No app code change
  expected; if registration is allowlisted, widen the `createRule`.
- **Random-sampling tz:** `runLifeTrackerSampling` uses the global
  `RANDOM_SAMPLES.timezone` for every log. Resolve each log's owner tz (reuse the
  `tzForUser` pattern already in `runLifeReminderCheck`) so a second user's
  check-ins fire in *their* timezone. Session reminders already do this — no
  change there.
- **Tests:** extend `services/api`'s e2e/unit coverage for the cron with a
  two-log fixture (two owners, two timezones) asserting each gets times in its
  own tz and no cross-pushing. (`services/api/src/e2e/*.test.ts`.)

### P1 — Data model (medium)

**Files:** new PB migration under
[infra/pocketbase/pb_migrations/](../../infra/pocketbase/pb_migrations/) (copy
`_TEMPLATE.js.example`, `YYYYMMDD_HHMMSS_life_log_manifest.js`);
[packages/backend/src/types/life.ts](../../packages/backend/src/types/life.ts)
(generic `Trackable` / `TypedField` types + `LifeLog.manifest`);
[packages/backend/src/pocketbase/life.ts](../../packages/backend/src/pocketbase/life.ts)
(`logFromRecord` maps `manifest`; `getOrCreateLog` seeds the starter set);
[packages/backend/src/interfaces/life.ts](../../packages/backend/src/interfaces/life.ts)
(an `updateManifest`/trackable-mutation surface, used by MCP in P4);
[apps/life/app/src/trackables.ts](app/src/trackables.ts) (becomes the seed
template module).

- **Migration 1 (schema):** add `manifest` JSON column to `life_logs`. Read JSON
  through `unwrapPbJson` per the repo convention.
- **Migration 2 (backfill):** for scott's existing log, write
  `manifest.trackables` from the 17 hardcoded `TRACKABLES`, **1:1, preserving
  ids**, and set each `fields[0].key` to the trackable's *historical* primary
  entry name (the value `primaryEntryName` returns today) so existing
  `life_events` keep aggregating. Tag it `pre-migration-*` per backup policy.
- **`getOrCreateLog` seeding:** on **create only**, copy the minimal type-demo
  starter set into `manifest`. Existing logs (post-backfill) are untouched. Guard
  the seed so it never overwrites a present manifest.
- **Tests (test-first):** `packages/backend` PB tests asserting (a) a fresh log
  gets the starter manifest, (b) an existing log's manifest is preserved across
  `getOrCreateLog`, (c) the backfill maps all 17 with ids + historical keys
  intact. (`packages/backend/src/pocketbase/*.test.ts` / `vitest.e2e`.)

### P2 — Generic field-driven renderer (medium, the headline lift)

**Files:** [apps/life/app/src/components/EventLogger.tsx](app/src/components/EventLogger.tsx)
(render from `fields[]`), [apps/life/app/src/components/EntryFields.tsx](app/src/components/EntryFields.tsx)
(add a `bool` toggle + reuse the existing category chip group as a field
renderer), [apps/life/app/src/lib/format.ts](app/src/lib/format.ts) (delete
`primaryEntryName`, aggregate by `field`), [apps/life/app/src/components/LifeDashboard.tsx](app/src/components/LifeDashboard.tsx)
+ [apps/life/app/src/components/Visualizations.tsx](app/src/components/Visualizations.tsx)
(read `state.log.manifest.trackables` instead of importing `TRACKABLES`),
[apps/life/app/src/manifest.ts](app/src/manifest.ts) (stop re-exporting
`TRACKABLES`/`GROUP_ORDER` as the runtime source; keep the seed export).

- Render the card from `fields[]`; preserve the one-tap / rating fast paths as
  derived shapes. Multi-field trackables (Movement = category + number) render
  the category chips + number editor in one form — the form already supports this
  combination today (exercise), it just becomes data-driven.
- Replace `primaryEntryName` usage with field-key lookups from the manifest.
- **Tests:** component/unit tests over EventLogger rendering each field type and
  writing the correct `entries[]` + `labels{}` shape; an e2e that logs against a
  seeded manifest trackable and reads it back. (`apps/life/app/vitest.e2e.config.ts`.)

### P3 — Quick entry: frecency + pins + global row, plus cleanups (medium)

**Files:** new frecency helper in `apps/life/app/src/lib/` (pure, over
`life_events`); [apps/life/app/src/components/EventLogger.tsx](app/src/components/EventLogger.tsx)
(chip row = pins ++ frecent, replacing `presets`); a new global quick-log row
component on [apps/life/app/src/components/LifeDashboard.tsx](app/src/components/LifeDashboard.tsx);
**deletions:** PWA `shortcuts[]` in [apps/life/app/vite.config.ts](app/vite.config.ts),
the `presets` field on `Trackable`, the `/quick/:trackableId` route in
[module.tsx](app/src/module.tsx), [QuickLog.tsx](app/src/components/QuickLog.tsx),
and the now-stale `/quick` mentions in [App.tsx](app/src/App.tsx)/[LifeDashboard.tsx](app/src/components/LifeDashboard.tsx) comments.

- Frecency: rank distinct `{entries,labels}` payloads per trackable by
  recency-weighted frequency over history; fill chip slots after pins. Zero
  storage. Continuous values won't surface stable chips (intended).
- Global row: top-N frecent + pinned payloads across all trackables, one-tap
  replay.
- **Tests (test-first):** pure unit tests for the frecency ranking (recency
  decay, dedupe, discrete-vs-continuous behavior); a regression test that the
  removed `/quick` route 404s / redirects cleanly.

### P4 — MCP tools (small–medium)

**Files:** [services/api/src/mcp.ts](../../services/api/src/mcp.ts) (new tools,
lines region near the existing life tools), the backend manifest-mutation
surface added in P1.

- `list_life_trackables`, `add_life_trackable`, `update_life_trackable`,
  `remove_life_trackable`, `reorder_life_trackables`, plus pin add/remove.
- **Enforce immutability server-side:** `update_*` must reject changes to
  `trackable.id` and any `field.key`; `add_field`/`remove_field` may add/remove
  fields but never mutate an existing key in place. Removal is manifest-only —
  events persist and re-link on re-add of the same id.
- **Tests:** MCP-level tests asserting id/key immutability is rejected, removal
  leaves events intact, and re-add re-links history.

### P5 (later) — In-app trackable editor

Thin settings UI over the same backend mutations P4 exposes. Deferred; MCP is the
v1 editing surface.

---

## Risks & open questions

- **`primaryEntryName` removal vs scott's history.** The whole id-coupling lives
  in this one switch. The plan removes it by keying each backfilled trackable's
  `fields[0].key` to the *historical* entry name. If a backfilled key drifts from
  the real historical `entries[].name`, that trackable's pre-migration history
  silently stops aggregating. **Mitigation:** the P1 backfill test must assert,
  per trackable, that the chosen key matches what `primaryEntryName` returns
  today and that a sample historical event still aggregates post-migration.
- **Frecency: discrete vs continuous.** Frecency is correct for discrete repeated
  payloads (doses, counts, oz, categories) and intentionally produces *no* stable
  chips for continuous values (sleep minutes). Don't "fix" the absence of sleep
  chips — that's by design; pins cover the few continuous shortcuts a user wants.
- **Immutable-id enforcement.** `id` and `field.key` are history join keys. The
  MCP layer (P4) and any future editor (P5) must refuse to rename them — only
  add/remove. Renaming = silent history orphaning. Enforce in the backend
  mutation, not just the UI.
- **`/quick` dead-code removal — verified.** `/quick/:trackableId` and
  [QuickLog.tsx](app/src/components/QuickLog.tsx) are reached **only** via PWA
  web-manifest `shortcuts[]` (confirmed: the route's own docstring, the
  [App.tsx](app/src/App.tsx) comment, and `vite.config.ts` all describe it as the
  shortcut target). The push-notification quick-rating path deep-links to
  `/life?quickResponse=...` (handled in [LifeDashboard.tsx](app/src/components/LifeDashboard.tsx)),
  **not** `/quick`. Removing `shortcuts[]` makes the route + component fully dead;
  safe to delete in P3. No notification deep-link blocks it.
- **Reminder cron is ALREADY multi-log (contradicts the P0 single-log
  assumption).** Both `runLifeTrackerSampling` and `runLifeReminderCheck`
  `getFullList()` over all `life_logs`, resolve each `owner`, and (for session
  reminders) use each owner's own tz via `tzForUser`. The session-reminder path
  needs **no** change for a second user. The *only* single-tenant residue is the
  random-sampling path's global `RANDOM_SAMPLES.timezone` (P0 above). This is a
  smaller P0 than the brief assumed.
- **Signup is OAuth-only in prod.** The email/password branch in
  [Auth.tsx](app/src/components/Auth.tsx) is DEV-gated. A second user onboards via
  Google OAuth; whether that "just works" depends on the PB `users` collection
  allowing open OAuth2 self-registration — verify in P0 (config, not code).
- **`category` field → `labels` round-trip.** The generic mapping puts `category`
  fields in `labels[field.key]` while measurement fields go to `entries[]`. The
  existing `categoryBreakdown` helper in EventLogger reads `labels.category`
  specifically; under multi-field-category trackables it must read
  `labels[field.key]` for each category field. Minor, but a real touch-point in P2.
