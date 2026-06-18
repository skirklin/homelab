# Unified Capture: Vocab + Views + Notifications design

**Status:** DRAFT for review — no code written yet. All open questions resolved (2026-06-18).
**v3** folds in an independent adversarial review (the §4 migration, the §2.1 board claim, and
the Phase-B split all changed as a result). The build is phased and gated on sign-off.

**Author:** Architect (Claude), 2026-06-18.

---

## 1. Why

Today the life app has **four parallel ways to capture something**, with different definitions
and two event shapes:

1. **Trackables** — per-user vocab (`took`/`did`/`happened`/`rated`) in
   `life_logs.manifest.trackables`. Logging writes a `life_events` row, `subject_id = id`.
2. **Session prompts** — `gratitude`/`intention`/`energy`/… defined *in code*
   (`apps/life/app/src/manifest.ts` `SESSIONS`). A session writes **one fat event**
   (`subject_id = "<id>_session"`) keyed by prompt id.
3. **Random samples** — `RANDOM_SAMPLES` config (in code), each question → a trackable.
4. **The dashboard capture surface** — the "I just opened the app" 2×2 shape-grid.

This is the "habits vs trackables vs sessions" confusion the user flagged. Sessions are
hardcoded — no custom ones, and **Angela can't have none.**

**Target:** three normalized, single-responsibility concepts.

- **Vocab** — *what* is capturable (incl. reflective prompts). One vocabulary; reflective text
  is a new `noted` shape. `shape` still picks the input control. A vocab row also carries
  optional prompt/hint/template-refs for when it's rendered in a view.
- **Views** — a *named, ordered set of capture items rendered for human input*. The unifying
  primitive: today's sessions are Views (guided), and the dashboard surface is conceptually a
  View (inline). One renderer.
- **Notifications** — *when to nudge*, a separate scheduled behavior with a pluggable strategy
  (fixed time, random sampling) that **targets a View**.

Once these are data, "Angela has some Views and zero notifications" is just config.

### Resolved decisions
- **Refs/prompt** live on the **vocab row**, not the view item.
- **`shape`** stays the immutable data contract AND picks the input control — **no widget
  registry**.
- **The INPUT-SURFACE EXCLUSION INVARIANT (load-bearing — see B2 fix):** default reflective
  vocab MUST be **non-hidden** (so Views can render it), so `hidden` cannot be what keeps it
  off habit/quick surfaces. **A `noted`-shape filter — applied at EVERY site that enumerates
  vocab for input** (HabitBoard long-tail, `GlobalQuickRow`/frecency, ShapeCard summaries, the
  2×2 grid) — is the mechanism. The whole design rests on this; get it wrong and Phase A ships
  a broken quick row.
- **Views unify the primitive now**, but this build keeps today's shape-grid as the home View's
  implementation; curated/time-of-day home view deferred.
- **Notifications** are a separate `manifest.notifications[]` concern; **random sampling is
  `strategy: "random"`.** The banner is a read-only **block** that writes no event.
- **Reminder *times* move into the notification strategy** (`strategy.time`), not the current
  separate `*_reminder_time` columns (see S3). **`reminder_state`** is a new JSON column keyed
  by notification id, replacing `last_*_reminder_sent`.
- **Defer** the `trackable → item` rename.

### Flagged pre-migration decision (needs your call — see B1)
Historical `evening_session.mood` / `weekly_review_session.mood_rating` rating entries exist in
old data, and there's a **live `mood` trackable today**. The redesigned sessions capture
`energy` but not `mood`. The migration must decide, explicitly: **(a)** route those legacy
ratings into the live `mood` series (restores them as mood data, but changes mood goal/chart
history), or **(b)** isolate them under a distinct legacy id so the live `mood` series is
untouched. This is your data; the migration hard-fails until every real entry name has a
disposition (no silent drop). **DECIDED 2026-06-18 (after the B3 audit): route into the live
`mood` series (option a).** Audit found exactly 10 legacy ratings — 9 `evening_session.mood`
(2026-05-21→05-31) + 1 `weekly_review_session.mood_rating` (2026-06-01), values 3–5 — all on
Scott's log only (Angela's log has zero session events). They map to `subject_id: mood` with
the canonical rated entry (`{name:"rating", unit:"rating", scale:5}`) to match the live series.

### Non-goals
- Renaming `trackable`. A configurable/curated home View or time-of-day rules. A widget builder.

---

## 2. The model

### 2.1 Vocab — `shape` (data contract + control) + render metadata + the exclusion invariant

`shape` sets the `entries[]` written **and** picks the input control (closed set). It gains one
member:

```ts
export type TrackableShape = "took" | "did" | "happened" | "rated" | "noted";
```

`noted` = free reflective text. `buildEntries("noted", { text })` →
`[{ name: "note", type: "text", value: text }]` (empty → `null`; `addEvent` rejects empty
`entries[]`). Aggregation already skips `text` entries (`shapes.ts:116-127`, verified), so
charts/goals/streaks are unaffected. "gratitude" → `{ id: "gratitude", shape: "noted" }`;
"energy" is `rated`. (Entry name is `note` singular; the `did` shape's optional companion is
`notes` plural — readers are name-agnostic, but don't conflate them.)

A vocab row gains optional **view-render metadata** (used when rendered in a View):

```ts
// added to LifeManifestTrackable:
prompt?: string;        // question text shown when captured in a view.
hint?: string;          // sub-label; may contain {token}s.
refs?: TemplateRef[];   // template references (see §2.4).
```

**THE EXCLUSION INVARIANT.** Reflective vocab is non-hidden, so a `noted`-**shape** filter — not
`hidden` — keeps it off input/replay surfaces. This must be applied at **every** vocab-enumerating
input site, verified to exist:
- `HabitBoard.tsx` long-tail (`filter(!hidden)`).
- `GlobalQuickRow` / `globalFrecentActions` (`frecency.ts:173` — filters on `hidden` ONLY today;
  replaying a free-text action is meaningless, so `noted` MUST be excluded here).
- `ShapeCard` summaries / `thingsOfShape` (`SHAPE_ORDER` has 4 members; a 5th `noted` is absent
  from the 2×2 grid — *accidentally* fine, but make it explicit, not incidental).

This work lands in **Phase A**, alongside adding the shape — or Phase A regresses the quick row.

### 2.2 Views — the unifying primitive

`life_logs.manifest.views`: a named, ordered set of capture items rendered for input.

```ts
export interface LifeView {
  id: string;            // IMMUTABLE. runner slug; written to labels.view.
  title: string;
  greeting?: string;
  icon?: string;
  render?: "guided" | "inline";
  items: LifeViewItem[];
}

export type LifeViewItem =
  | { kind: "capture"; trackableId: string; optional?: boolean }  // prompt/hint/refs on the vocab row.
  | { kind: "tasks_due" }                                          // declarative upkeep-due header.
  | { kind: "banner"; text: string; refs: TemplateRef[] };        // read-only templated echo; NO event.
```

- **Sessions are Views** rendered `guided`: morning/evening/weekly become `DEFAULT_VIEWS`.
- **The dashboard surface is conceptually the inline View** — but *this build keeps the current
  shape-grid implementation*; the win now is one shared renderer the dashboard converges toward.
- **Renderer contract:** non-capture blocks (`tasks_due`, `banner`) render *before* the first
  capture step (matching today's MorningUpkeepHeader + week-intention banner above the prompts).
- The `banner` drops if its required ref is absent (no event written either way).

### 2.3 Notifications — scheduled behavior, pluggable strategy, targets a View

`life_logs.manifest.notifications`, decoupled from View content:

```ts
export interface LifeNotification {
  id: string;            // IMMUTABLE. keys reminder_state.
  target: string;        // View id to open.
  strategy: LifeNotifyStrategy;
  enabled?: boolean;
}

export type LifeNotifyStrategy =
  | { kind: "fixed"; cadence: "daily" | "weekly"; time: string /* "HH:MM" */;
      weekday?: number; subsumes?: string[] /* notification ids replaced on its day */ }
  | { kind: "random"; timesPerDay: number; activeHours: [number, number] };
```

- Sampling = `{ kind: "random" }` targeting a View of sample items.
- **`subsumes` must reproduce BOTH halves of today's Sunday behavior** (`life.ts:336-339` evening
  suppressed AND `:404-405` weekly fires only Sunday), plus the `withinWindow(±1)` +
  mark-after-success retry semantics — this is ~250 lines of already-bug-fixed code, see S2.
- The `random` strategy must preserve the per-log `random_sampling_enabled` gate and the
  `sample_schedule` state machine (`life.ts:123,135-163`).
- **Reminder *times* move here** (`strategy.time`) from the `*_reminder_time` columns; SettingsModal's
  pickers + the backend `LifeLog` type + `setReminderTimes` rewire, and a migration copies the
  old column values into `DEFAULT_NOTIFICATIONS` (S3).
- **Runtime sent-state**: new `reminder_state` JSON column on `life_logs`,
  `Record<notificationId, "YYYY-MM-DD">`, replacing `last_*_reminder_sent`.

### 2.4 Templating — named multi-token, on the vocab row

```ts
export interface TemplateRef {
  token: string;          // {token} in prompt/hint/banner text.
  fromTrackable: string;  // a vocab id.
  within: "day" | "week"; // owner-local lookback.
  entry?: string;         // entry name to pull; default per shape.
}
```

Resolver (client-side): per ref, find the most recent event for `fromTrackable` in the window,
substitute. **A required (non-`optional`) ref that fails to resolve drops the step** — preserving
today's "no *you-skipped-this* nudge." Replaces `findMorningIntention`/`findCurrentWeekIntention`/
`contextKey`.

### 2.5 Event storage — per-item, correlated by `labels.view`

A guided View run writes **one `life_events` row per captured item** (own vocab `subject_id`,
single-shape `entries[]`). The run's N events correlate by labels (plain JSON — **no schema
migration**):

```
labels.source   = "manual"
labels.view     = "<viewId>"
labels.view_run = "<ISO timestamp of the run>"   // groups one run's N events
```

Journal/DayTimeline group a run by `(view, view_run)`. Ad-hoc inline-surface captures stay plain
single events. This is the biggest change: sessions used to group by *being one fat event*; now by
*a shared label across N events*.

---

## 3. Defaults + the vocab-id map

`DEFAULT_VIEWS` + `DEFAULT_NOTIFICATIONS` + default reflective vocab reproduce today's sessions.
Prompt ids become **distinct vocab ids** — today's `entries[].name` collide across sessions
(verified against the live manifest) and must split:

| Today (`subject_id`.entry) | New vocab id | shape | notes |
|---|---|---|---|
| morning.`gratitude` | `gratitude` | noted | |
| morning.`intention` | `daily_intention` | noted | **collides** w/ weekly.intention |
| morning.`energy` | `energy` | rated | |
| evening.`intention_followup` | `intention_followup` | noted | refs `daily_intention` |
| evening.`win` | `daily_win` | noted | |
| evening.`lesson` | `daily_lesson` | noted | **collides** w/ weekly.lesson |
| weekly.`highlights` | `highlights` | noted | |
| weekly.`lows` | `lows` | noted | |
| weekly.`lesson` | `weekly_lesson` | noted | |
| weekly.`intention` | `weekly_intention` | noted | |
| **historical** evening.`mood`, weekly.`mood_rating` | **see B1 decision** | rated | NOT silently mapped |

Prompts (“What are you grateful for?”, etc.) live in each vocab row's `prompt`.

---

## 4. Event migration (history rewrite) — revised per review

Fan one `*_session` event OUT into N per-item events. Model on `merge-sleep-quality.ts`'s
create+delete with crash-safe ordering. Pure planner `planSessionFanout(events, tz)` in
`services/scripts/historical/lib/life-rewrite.ts`, fully unit-tested, no I/O.

**Step 0 — audit (do this BEFORE writing the planner).** Query real production `*_session`
events and enumerate **every distinct `entries[].name`** that actually occurs (not from the
manifest — from the data). Build the disposition table; resolve the B1 `mood`/`mood_rating`
decision. **The planner hard-fails on any entry name without an explicit disposition** —
map-to-existing, map-to-new, carry-forward, or skip — so nothing is silently dropped with the
deleted source.

**Per `*_session` event:** N `create` actions (mapped vocab `subject_id`, single-entry
`entries[]`, `labels: { source, view, view_run: <event.timestamp> }`, same timestamp/created_by),
then **one `delete` of the source, ordered last**.

**Per-child idempotency (S1).** The rerun check is **per child** by `(subject_id, view_run)`, not
binary on the run. A partial/crashed run that created 2 of 3 children: the rerun creates the
missing third, THEN deletes the source. Never delete the source until the full expected child set
is present.

**Driver:** `--dry-run` default, `--apply`, `--log <id>` (hard-error on missing value), prod
`PB_URL` default, exit `0/1/2`. Take a `pre-migration-*` backup first (kept forever). Smoke test
(`smoke-life-rewrite.ts`): seed all three session shapes, the historical mood case, AND a
partial/crashed run; assert dry-run inert, apply correct, rerun no-op.

**Also materialized:** default reflective vocab rows → `manifest.trackables`; `DEFAULT_VIEWS` →
`manifest.views`; `DEFAULT_NOTIFICATIONS` (with reminder times copied from the old columns) →
`manifest.notifications`. New logs seed all at creation. Angela: `manifest.notifications = []`,
trim Views, hide reflective vocab.

**Runs in the same deploy as the write-path flip (B3)** — see Phase B3.

---

## 5. Every touched surface

**Frontend (`apps/life/`):**
- `manifest.ts` — delete `SESSIONS`/`SessionPrompt`/`sessionSubjectId`; `RANDOM_SAMPLES` → a
  default `{kind:"random"}` notification.
- `lib/shapes.ts` — `noted` shape + control; `lib/frecency.ts` (`globalFrecentActions`) +
  ShapeCard summary sites — apply the `noted` exclusion (B2).
- `SessionRunner.tsx` → the guided **ViewRunner**; `MorningUpkeepHeader` + intention resolvers
  become data.
- `LifeDashboard.tsx` — session cards read `manifest.views`; reflective vocab view-only.
- `Journal.tsx` / `DayTimeline.tsx` / `SessionStreakGrid.tsx` — group N events by
  `(view, view_run)`; **group-aware, reading BOTH shapes** through the cutover (B3).
- `HabitBoard.tsx` — exclude `noted`; `noted` taps route to the sheet.
- `SettingsModal.tsx` — reminder-time pickers rewire to edit the notification (S3).
- New: `useViews()`, `useNotifications()`, `lib/templating.ts`.

**Backend / API (`services/`):**
- `lib/observer/bundle.ts` — **highest-risk read.** Rewrite to group per-item events by
  `(view, view_run)` and read by vocab `subject_id`. **Preserve the non-session branches**
  (`quick_capture`, `exercise` special-cases at `:369-376`) untouched (S5). Update in lockstep
  with the cutover (B3); re-verify after migration.
- `lib/notifications/life.ts` — read `manifest.notifications`; strategy dispatch. Reproduce
  `subsumes` (both Sunday halves) + mark-after-success + the sampling state machine. Own
  parity-test (S2). `reminder_state` replaces `last_*`.
- `routes/data.ts` + `mcp.ts` — `/life/views` + `/life/notifications` CRUD + MCP tools. **Update
  `add_life_entry`'s description** (drops the `morning_session` example, `mcp.ts:507`) (S4).
- `packages/backend` — `LifeLog` type: reminder times move off columns; `setReminderTimes`
  rewires; new `reminder_state` column mapping.
- `services/scripts/historical/` — the fanout migration (§4).

**Schema:** none for events (labels are JSON). New `manifest.views`/`manifest.notifications` JSON
keys (no migration). New `reminder_state` JSON column; the `*_reminder_time` columns are migrated
into the manifest then can be retired.

---

## 6. Phased build — Phase B split per review

- **Phase A — vocab plumbing.** Add `noted` shape + control + the prompt/hint/refs render-metadata +
  **the `noted` exclusion at every input site (B2)** + MCP enum. Add default reflective vocab rows.
  No View/notification change (sessions keep working). Gate: quick row + board show no reflective
  vocab; sessions unchanged.
- **Phase B1 — data models.** `LifeView`/`LifeNotification` types + `DEFAULT_VIEWS`/
  `DEFAULT_NOTIFICATIONS` + `useViews`/`useNotifications` + `lib/templating.ts`. No behavior change
  (sessions still run the old path). Fully additive.
- **Phase B2 — ViewRunner at parity, STILL writing the fat `*_session` event.** Prove the data-driven
  renderer (templating + tasks_due + banner) reproduces the wizards with **zero event-shape change** —
  fully reversible. `SESSIONS` / `sessionSubjectId` / `sessionPath` STAY in `manifest.ts` through B2 —
  the readers (Journal, DayTimeline, SessionStreakGrid, LifeDashboard) still consume them, and the
  fat-event shape is unchanged. They are removed in **B3**, when the readers are made group-aware and
  the write path flips to per-item events. (The ViewRunner deletes only `SessionRunner` /
  `MorningUpkeepHeader` / the `findMorningIntention`/`findCurrentWeekIntention` resolvers — all
  superseded by `lib/templating.ts`.)
- **Phase B3 — the cutover (one deploy).** Flip the runner to per-item events (`labels.view*`) +
  make Journal/DayTimeline/SessionStreakGrid/`bundle.ts` group-aware (read both shapes) + **run the
  §4 migration in the same deploy** so no day ever shows mixed shapes (B3). Backup first; the
  migration is dry-run-verified ahead of time. This is the irreversible, highest-risk slice —
  isolated and small.
- **Phase B4 — notification cron rewrite.** Independent of the runner; can land any time after B1.
  Strategy dispatch (fixed + random + subsumes + reminder_state) with the parity test (S2).
- **Phase D — editors + cleanup.** `/life/views` + `/life/notifications` MCP CRUD + the in-app
  View/notification editor (SettingsModal absorbs reminder editing). (Optional rename codemod.)
- **Phase E — Angela.** `manifest.notifications = []`, trim Views, hide reflective vocab.

Ordering rationale: A and B1/B2 are additive/reversible (no event-shape change). B3 concentrates
the irreversible change + the read-shape change into one small, backed-up deploy, eliminating the
incoherent dual-shape window. B4 is orthogonal. D/E are data/UI only.

### Deferred (model-supported, not built now)
- Curated/user-ordered home View; time-of-day conditioning; the input-type registry.

---

## 7. Risks

- **Coach AI silent degradation** (`bundle.ts`) — highest-risk read; update in B3 lockstep, re-verify
  after migration. Preserve the non-session branches.
- **B1 data loss** — historical `mood`/`mood_rating`; resolved by the audit + hard-fail-on-unmapped +
  the flagged disposition decision.
- **Input-surface exclusion** — the whole design rests on the `noted`-shape filter at every
  vocab-enumeration site; a missed site leaks reflective vocab into the quick row/board.
- **Irreversibility** — fanout deletes source events; `pre-migration-*` backup (kept forever),
  dry-run default, per-child idempotent rerun, run inside the cutover deploy.
- **Notification parity** — `subsumes` + retry + sampling state machine must match today's send
  decisions byte-for-byte; B4 parity test gates it.
- **Templating drop-if-absent** — required unresolved ref drops the step; must not render blank.
