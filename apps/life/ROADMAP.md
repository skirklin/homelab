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
