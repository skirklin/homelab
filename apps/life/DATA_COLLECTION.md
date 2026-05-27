# Data collection for the AI observer feedback loop

Written 2026-05-27, after running a one-shot observer experiment on 14 days of real data. Two audiences:
- **Scott** — strategic framing on what to invest in before Phase 2 of the [roadmap](./ROADMAP.md) is worth shipping
- **Life-app agent** — concrete, file-grounded recommendations for the next data-collection changes

Both audiences should read everything; the labels just say who each recommendation is primarily aimed at.

**Status snapshot (updated 2026-05-27):**
- **Shipped:** A1 (pull morning intent into evening session), F1 (reject empty-payload events at write time). Both merged in commit `8a12639`. The remaining source-layer recommendations are queued.
- **Doc restructure:** added the source-vs-view-layer split (see "Two layers" below). Almost everything originally written here was a source-layer recommendation; view-layer recommendations now have their own section.

## What the experiment actually proved

Four observation styles ("Sunday letter," "sharp observer," "pattern hunter," "reflection prompter") were run by a Claude session with MCP access, on the user's real `life_events` for May 13–27, 2026. Two of four produced something worth reading. **All of the load-bearing insight came from the journal text fields** (`gratitude`, `intention`, `win`, `lesson`). **None of it came from the numeric trackers.**

That's not a bug in the experiment — it's a structural fact about what LLM observers are good at. An LLM reads language. With 14 days of single-user data, there is no statistical pattern in coffee/sleep/edibles numbers for any tool to find. Even with 6 months of data, finding "you sleep worse after edibles" is a stats job, not a language-model job.

The implication: **the AI observer is a journal reader, not a habit-data analyst.** The right product is one where the model reads what you wrote and connects it across days. The numeric trackers serve the dashboard, the streak, and the heatmap — they don't feed the observer.

## Two layers: source data vs. observer view

The recommendations below split cleanly across two layers, and treating them as one thing pushes false dependencies.

**Layer 1 — Source data.** What gets written into `life_events`, `cooking_log`, `task_events`, etc. Has many consumers beyond the observer (dashboard, heatmap, streak, export, Insights view). Changes are slow because they touch UX, schemas, and habits. Almost everything in the original draft of this doc — the Add / Fix / Drop sections below — is source-layer work.

**Layer 2 — Observer view.** A transformation that takes raw source data and produces a clean digest for the AI specifically. Lives in `services/api/src/lib/observer/` once Phase 2 starts. Single consumer (the model call). Cheap to change. The system prompt is part of this layer too.

### Why the split matters

- **A usable observer can ship now**, against messy source data, by giving the view layer the responsibility to clean things up before the model sees them. You don't have to wait for every source-layer fix to land.
- **View-layer experiments are cheap and reversible.** Try a different window, join, format, or prompt without touching a byte of source data. Source-layer experiments require schema/UX changes and dogfood time.
- **As source fixes ship, view-layer logic simplifies.** F1 → view doesn't need to drop empty-payload events. A1 → view doesn't need to manually join morning intention to evening reflection.
- **The split clarifies which problems each layer can actually solve.** A view layer can aggregate, format, contextualize, cross-source join, redact, prompt-shape. It cannot recover information that was never captured.

### What only each layer can do

| Concern | Source-only | View-only | Both |
|---|---|---|---|
| Recover never-captured data (no notes field) | ✓ | | |
| Resolve unit confusion (8 vs 480 sleep) | ✓ (write guard) | partial (flag, can't fix) | |
| "Skipped vs missed vs zero" semantics | ✓ (sentinel entry) | partial (heuristic) | |
| Aggregate ("you flossed 5x this week") | | ✓ | |
| Cross-collection join (life + cooking + tasks) | | ✓ | |
| Contextualize ("week before a 6-day trip") | | ✓ | |
| Normalize timestamps to user-local | partial (capture intent) | ✓ (presentation) | ✓ |
| Stated intent → reflection reconciliation | A1 makes it structural | could heuristic-match | A1 + view-layer surfacing |

Each recommendation below is tagged `[source]` or `[view]` (`[both]` when there's a meaningful cross-cutting concern). See the cross-cutting map at the end of "View-layer recommendations" for which source fixes retire which view-layer hacks.

## What the AI observer needs to do its job well

In rough priority order (highest leverage first):

1. **More text, with structure.** Morning intentions, evening reflections, weekly reviews — every text field is high-value. The observer's best move was "you wrote X as a morning intention three times and never came back to it."
2. **Continuity between entries.** The observer caught that morning intentions don't get pulled forward to evening reflection. That's a *language* problem — the app doesn't carry intent across sessions. Fixing it inside today's wizards (no AI involvement) is one of the highest-value changes available.
3. **Stated themes / horizons.** "This season is about physical rehab." "This year's theme is presence over autopilot." Without a named horizon, observations are just descriptive; with one, observations become "you said X, you did Y, here's the gap."
4. **Light context on numeric events.** A coffee entry alone is noise. A coffee entry tagged `pre_workout: true` is signal. The schema supports this (`labels`) — the UI doesn't surface it.
5. **Honest sparseness.** "I didn't log this" vs "I did this and it was zero" vs "I skipped this on purpose" are three different things. Currently all three look identical in the data.

The next four sections are recommendations bucketed by direction: things to **add**, things to **fix**, things to **drop**, and things to **not build**.

## Add

### A1. Pull morning intent forward into the evening session — wizard only, no AI `[source]` — ✓ shipped 2026-05-27

> Audience: agent. Highest leverage / cheapest item in this doc.

When `/evening` opens, look up today's `morning_session` event. If it exists and has an `intention` value, surface it in the wizard with one new prompt:

```
This morning you wrote: "<intention text>"
[ ] Did you move on it?         text field, optional
```

This is the **Style 3 finding** from the experiment, implemented as ~30 lines of wizard code with zero AI dependency. It creates the continuity the observer was reaching for. The new field becomes a new entry on the `evening_session` event — call it `intention_followup`. No migration needed; new entries in `entries[]` are additive.

Source pointers:
- Session schema: [apps/life/app/src/manifest.ts:84-109](app/src/manifest.ts#L84-L109)
- Add a new prompt to the evening `prompts[]`, and load today's morning event in the SessionRunner.

### A2. Add a `themes` collection — what's the season about? `[both]` (source adds the data; view layer is what surfaces it to the observer)

> Audience: agent (small build) + Scott (decide if you want this)

A separate PB collection (or just a single `themes` widget keyed off `life_logs.owner`) where the user names 1–3 short freeform "what's important right now" strings. Examples: *"rehab the arm"*, *"cook one new thing a week"*, *"stop multitasking at home"*. Update cadence is monthly-ish, not daily.

This is the bridge between intention and observation. Without it, the observer can describe activity. With it, the observer can compare activity to stated intent — which is the actual job.

Schema sketch (mirror life_events conventions):

```
collection: themes
  log:        relation -> life_logs (owner-scoped, same as life_events)
  text:       text                    "rehab the arm"
  set_at:     date
  retired_at: date | null             null = active
```

Surface: one extra card on the dashboard near the top, "Currently…" listing active themes, plus a Settings page to add/edit/retire. Observer reads `themes` first to anchor every observation.

### A3. Adopt a free-form `quick_capture` event type `[source]`

> Audience: both. Modest build, big payoff for the observer.

Today's data shape forces every event into a named trackable. If you have a thought at 2pm — "I'm noticing I've been irritable since the Mexico trip got real" — there's no slot for it. The morning/evening sessions are the only freeform-text containers, and they're once-a-day, time-locked, and prompt-bound.

A `quick_capture` event with one freeform `text` entry, plus optional tags, is the missing capture surface. One button on the dashboard, a 30-second flow. Implementation can reuse the existing event pipeline (`subject_id: "quick_capture"`, `entries: [{name: "text", type: "text", value: "…"}]`).

This is the single fastest way to grow the observer's signal density without adding new numeric trackers.

### A4. Make `notes` ubiquitous, optional, and one tap away `[source]`

> Audience: agent

Several trackables already support `hasNotes: true` (sleep does — [trackables.ts:89](app/src/trackables.ts#L89)). Extend the pattern so that *any* trackable's full-form view can attach an optional note. Cost: small. Value to the observer: large. A coffee at 11pm with the note "couldn't focus, anxious about house stuff" is the kind of event that ties the numeric and text data together — and produces an observation neither would produce alone.

Don't require notes; just make them frictionless when the user has one.

### A5. Capture the *time* on real-time logs, capture only the *date* on backfills `[source]`

> Audience: agent

The data has many entries with timestamp `19:00:00.000Z` — clearly synthetic, generated by some backfill UI defaulting to midnight-PT. This destroys any time-of-day analysis. Two changes:

1. When the user logs an event "now," capture the actual timestamp (already happens for some entries — the recent ones with millisecond precision).
2. When the user backfills "yesterday" or any other day, **store the date but mark the time as unknown** (e.g., `timestamp_precision: "day"` on labels, or omit time entirely if the schema can express that). Don't fabricate `19:00:00`.

The observer can then say "you exercised most often in the evenings this month" *truthfully*. Today it can't.

## Fix

### F1. Stop generating empty-payload entries `[source]` — ✓ shipped 2026-05-27 (see V1 for residual historical rows)

> Audience: agent. This is the biggest data-hygiene problem.

In the 14-day sample, ~10 entries had `entries: []` — coffee/sleep/poop/mood/content events with no value. These came from a UI path where the user tapped "log" without committing a value (or canceled a form mid-edit, or the random-sample popover wrote-then-skipped). They're indistinguishable from real logs and they actively poison observation: the observer sees "8 sleep events in 14 days" when really there are 3 with data.

Two fixes, in order of preference:

1. **Don't write the event if no values are present.** Treat a value-less submission as a no-op, not a submission. (Preferred.)
2. If there's a real reason to record a "tapped but skipped" event, give it a different `subject_id` (e.g., `<subject>_prompt_dismissed`) so it doesn't pollute the canonical trackable's data.

Audit every code path that calls `addLifeEntry` and check whether the entries array can be empty at write time.

### F2. Unit-confusion guard on sleep (and any duration trackable) `[source]`

> Audience: agent. Small but real.

`life_events.id: dhkdz3m0v3v2hye` on May 26 has `value: 8, unit: "min"` — clearly meant 8 hours = 480 minutes. The inline form already auto-switches to hours input when `defaultValue >= 60` ([trackables.ts:87](app/src/trackables.ts#L87)), but something allowed an 8-minute sleep entry through. Either the conversion isn't happening on submit, or there's a code path (preset chip? backfill?) that bypasses it.

Add a sanity range on write: a sleep entry < 60 minutes triggers a confirm modal — "you slept for 8 minutes?" — and if confirmed, persists with a `labels.confirmed_outlier: true` flag so the observer knows it's intentional. Otherwise: re-prompt.

Same pattern for any time-based trackable with `defaultValue >= 60`.

### F3. Distinguish "missed" from "skipped" from "zero" `[source]`

> Audience: agent + Scott (decide if the distinction matters)

Sleep wasn't logged on most days in the sample. Was that "didn't sleep" (zero), "forgot to log" (missed), or "chose to skip" (skipped)? The observer doesn't know, and conservatively treats them all as "no data." The truthful answer is almost always "forgot to log," but the app has no way to record that.

Minimum viable fix: a long-press on the dashboard card surfaces a "mark as skipped today" option. Writes a sentinel entry (`labels.skipped: true`, `entries: []`). Now the observer can say "you logged sleep 4 days and skipped 1 day; the other 9 are missing" instead of treating all 10 as missing.

Lower priority than F1; only worth doing once empty-payload entries are eliminated, so the sentinel is meaningful.

### F4. Patch the broken floss-delete UI `[source]`

> Audience: agent

The May 21 data had 8 identical floss entries because the user couldn't delete the dupes. Cleaned up by hand this session. Worth confirming that the delete affordance on [EntriesPopover](app/src/components/EntriesPopover.tsx) works for count-style trackables and not just session events. If it's broken, fix it; if it's hidden, surface it.

## Drop

### D1. Don't keep adding numeric trackers in pursuit of "more data"

> Audience: Scott (this is the strategic call)

The instinct after running the experiment is "I need more habit tracking." That's the wrong move. Adding a "minutes meditated" or "pushups" trackable doesn't make the observer better — there's nothing for it to observe in a number-with-no-context. The observer got value from journal text and from the *cross* of journal text against numeric events ("you said you wanted to get back to the gym; you exercised twice").

The right move is to make the *existing* surface richer:
- text on more events (A4)
- a free-form capture (A3)
- continuity between sessions (A1)
- stated themes (A2)

Add new numeric trackers only when you actually want them on the dashboard for your own sake — not because the observer needs them.

### D2. Restart random sampling only if you'll actually fill in text alongside

> Audience: Scott

`mood` and `content` are `hidden: true` ([trackables.ts:104-106](app/src/trackables.ts#L104-L106)) because random sampling is paused. The data shows two `mood`/`content` events on May 22 with empty payloads — sampled, dismissed without a value. A 3/5 mood at 4pm with no text is not useful to the observer. A 3/5 mood at 4pm with "felt scattered after the meeting" is useful. Decision: either re-enable sampling *with mandatory short text*, or leave it off and rely on the morning/evening sessions for affect data.

## Don't build (yet)

### N1. Don't build statistical correlation views

You don't have the data volume for it, and even if you did, the LLM observer is the wrong tool. Plotting "mood vs edibles" is something the dashboard can do once there's enough data; asking an LLM to find correlations is asking a screwdriver to drive a nail.

### N2. Don't build a "hardcoded insights" engine

The roadmap already says this ([ROADMAP.md anti-patterns](./ROADMAP.md)) — calling it out again because it's tempting after seeing the experiment work. The whole point was that Claude can produce observations the user wants to read. The moment you hard-code "if sleep < 7 hours for 3 days, show warning," you've rebuilt the third-party-app pattern you're explicitly avoiding.

### N3. Don't conversationalize the observer until the passive form is proven

Style 4 in the experiment ("reflection prompter") was the most aspirational shape: a Claude that asks you tailored follow-up questions during the evening session. That's a much larger build (chat surface, multi-turn state, prompt engineering against partial answers) and the value is unproven. Ship a passive observation (weekly digest, daily briefing, on-demand "ask Claude about my week") first and learn from it. Conversational comes later if the passive surface produces things worth reacting to.

## View-layer (observer-side) recommendations

Things to design into the observer's data-preparation step (`services/api/src/lib/observer/...`, when it exists). Ordered by how much they let us defer source-layer work and how directly they unblock shipping a usable observer. Every item here is tagged `[view]` — that's the whole point.

### V1. Drop empty-payload events at view time `[view]`

> Audience: agent. Defensive layer behind F1; primary remediation for pre-F1 historical rows.

The F1 backend invariant blocks new empty-payload writes, but historical rows from before F1 are still in the database — and any future code path that slips past the invariant would otherwise be invisible to the observer. The view layer should filter `entries.length === 0` before handing data to the model.

### V2. Aggregate duplicates by `(subjectId, localDay)` for count-typed trackables `[view]`

> Audience: agent.

The May 21 floss data (8 identical entries) would have been hidden from the observer entirely if the view-layer aggregator collapsed same-day same-subject events. Pattern: `groupBy(subjectId + localDay) → sum count` for count/duration trackables; preserve individual entries for text-bearing types (sessions, future `quick_capture`). The output shape becomes "5 floss events" not "5 separate events all listed."

### V3. Materialize a "themes" view heuristically, before A2 ships `[view]`

> Audience: agent.

The view layer can extract recurring noun phrases (or, more robustly, ask a cheap LLM call to extract them) from recent morning intentions / evening lessons and present them as inferred themes. "Recurring threads this period: house decluttering, physical rehab, cooking goals." No new collection needed. When A2 lands the real `themes` collection, swap the heuristic for the real source — the observer's prompt doesn't change.

### V4. Bundle cross-source data into a single document `[view]`

> Audience: agent. Single biggest leverage item on this list.

Today's MCP tools return `life_events`, `cooking_log`, `tasks`, `travel` separately. The observer has to know to fetch each. A view-layer document — call it `observer_bundle` — that pre-joins them into a unified narrative shape:

```
Period: 2026-05-13 → 2026-05-27 (14 days, user-local)
Active trip: Mexico City, departs 2026-06-02 (6 days out)

Sessions logged: 6 morning, 7 evening, 0 weekly
Exercise events: 2 (May 25 walk 2h intensity 2, May 27 lift 75min intensity 5)
Cooking events: 1 attempt (May 26 ciabatta — flagged "went badly")
Tasks completed: 7 (all Mexico City trip prep)
Tasks open: 3 (Mexico City prep), plus recurring household

Recurring themes in journal text:
  - Physical rehab / personal trainer (5 mentions: May 21, 22, 23, 24, 27)
  - Donations + Facebook friction (3 morning intentions: May 24, 26, 27)
  - Cooking goal slip (May 21 evening, May 26 evening)

Notable threads:
  - 2026-05-26 morning intention: "sit with the feeling of wanting children
    and try to figure out what to do with that feeling" — not addressed in
    that evening's session (win was "hiking with Owen and Rihanna")
  - 2026-05-21 evening: "haven't made anything new this week other than
    chocolate chip cookies" → next cooking event 5 days later (May 26
    ciabatta, failed)
```

…is much easier for the model to reason over than four separate JSON arrays. This is the cheapest path to actually testing observation quality on richer data — without any source-layer work.

### V5. Compute derived fields the source can't (or doesn't yet) express directly `[view]`

> Audience: agent.

Things like "did the morning intent get reflected in the evening?" can be computed in the view layer even without A1's `intention_followup` field. With A1 it becomes a direct join; without, it's a heuristic ("did the evening session text mention any noun phrase from the morning intention?"). Either way, the *derived* field is what the observer sees — letting the prompt assume the field exists, and letting the view layer evolve underneath as source improvements land.

Other candidate derived fields:
- `days_since_last_<subject>` (last cooking event, last exercise, etc.)
- `intent_followthrough_pct` over a rolling window
- `cross_session_silence` (intentions named in morning but never appearing in any subsequent evening text)
- `trip_proximity` (days until next booked trip, computed from travel data)

### V6. Format the bundle as prose, not JSON `[view]`

> Audience: agent. Easy to overlook.

The model produces sharper observations on a brief prose document ("Wednesday morning, Scott wrote: 'I want to get back to climbing.' Wednesday evening, he reflected: 'Pushed at the gym but stopped before going too far.'") than on raw JSON event arrays. The view layer's last step should render to markdown. JSON is for the machine reading the data; the model reads English better.

### V7. Make the view layer observable to the user `[view]`

> Audience: both (small UI investment, large debug payoff).

Surface the rendered observer bundle in the app — e.g., an `/observations/preview` route that shows exactly what the model will be sent. Without this, observation quality regressions are invisible: was the observation thin because the model's bad, or because the bundle was missing data? With it, you can spot "ah, the bundle didn't include this week's cooking_log" in seconds.

### Cross-cutting map: source improvements that retire view-layer logic

The view-layer items are designed to be **transient scaffolding** — built once, simplified or retired as the source catches up. The migration is bidirectional: build view-layer cleanup first to unblock observer shipping, then retire pieces as the corresponding source fix lands.

| When this source fix ships… | …this view-layer logic can be retired or simplified |
|---|---|
| F1 (no empty payloads written) — ✓ | V1 partial (still needed for historical rows; can be removed once historical rows are purged) |
| F4 (UI delete works) | V2 partial (no need to defend against UI-bug dupes specifically; still useful for legitimate same-day repeats) |
| A1 (intention_followup field) — ✓ | V5 partial (direct join replaces the noun-phrase heuristic for this specific derivation) |
| A2 (themes collection) | V3 (replace heuristic with real source; observer prompt unchanged) |
| A3 (quick_capture events) | (none — pure additive signal; V4 just gains another section to surface) |
| A4 (notes everywhere) | (none — pure additive signal) |
| A5 (real timestamps + date precision) | V-time-of-day analyses become trustworthy; before A5, the view layer should drop time-of-day claims rather than make false ones |

What does NOT retire: V4 (cross-source bundle), V6 (prose format), V7 (preview surface). Those are intrinsic to the view layer, not workarounds for source issues.

## Concrete first cuts for the agent

With the two-layer split made explicit, this is no longer a single-priority list — it's a strategic choice across three paths. Pick one to drive, then optionally back-fill from the other.

### Path A — Source-first (continue current trajectory)

Keep investing in source quality before standing up the observer. Highest-leverage remaining items:

1. **A3** — `quick_capture` event type. Reuses the existing pipeline; mostly UI. Highest-impact single change for observer signal density.
2. **A4** — extend `hasNotes` to all trackables (opt-in, optional). One field, every trackable's full form.
3. **F2** — sanity-range confirm on sleep duration. Small. Eliminates the 8-min-vs-480-min ambiguity.
4. **A5** — distinguish backfill-date from real-timestamp. Largest schema change; defer until after the first three.
5. **A2** — `themes` collection. Net-new collection + a small UI. Defer until Phase 2 build starts; the observer will want this as an anchor.

When complete, the source surface is ready for a thin-view-layer observer to work against. **Tradeoff:** several weeks of dogfooding before any AI-side validation happens.

### Path B — View-first (ship a v0 observer against today's source)

Build the view layer over what we already have, ship a passive observer, learn from real output, and let that feedback inform what to fix in the source. Highest-leverage view items:

1. **V4** — cross-source bundle (`observer_bundle` shape). Single biggest move. Pre-joins `life_events` + `cooking_log` + tasks + active trip context.
2. **V6** — prose formatter on top of V4. Cheap; ~50 lines.
3. **V1 + V2** — empty-payload filter + duplicate aggregator. Defensive scrubbers.
4. **V7** — `/observations/preview` route surfacing the rendered bundle. Critical for debugging observation quality.
5. **First Anthropic API call** — wire V4 output + a system prompt into `/api/observations/generate`. Persist to `claude_observations` (Phase 2 schema). One scheduled cron, weekly.

When complete, the loop is *closed* — observations land in the app, you read them, you have signal on which source-layer items are actually blocking quality. **Tradeoff:** the first observations will be thinner than the source-fully-ready version. That's the explicit experiment.

### Path C — Hybrid (lean into the cheapest items from each)

If neither path feels right, the highest-leverage moves regardless of path are:

- **A3** (`quick_capture`) — pure additive signal, retires no view-layer logic, but raises the ceiling for every future observation.
- **V4 + V6** — cross-source bundle in prose. Most of the observer-shipping work, deferrable on every source-layer item.
- **V7** preview surface — pays off both paths.

Then ship V0 of the observer against whatever source state exists, and prioritize remaining source-layer items based on what the first observations actually struggled with.

### Strategic call (for Scott)

The original draft of this doc was implicitly Path A — "fix the source first, then build the observer." The view-layer split makes Path B and Path C newly available, and changes the calculus: Path A's strongest argument was "no point shipping an observer that reads slop," but a view-layer cleanup pipeline addresses much of the slop without source-layer waiting.

My current lean is **Path C** — A3 is high-leverage regardless, and V4+V6+V7 + a v0 observer call is genuinely shippable in a focused day. Real observation output on real data, even if thin, beats more theorizing about what the source should look like.

This is a decision worth flagging explicitly — see "Open questions for Scott" below.

## Open questions for Scott

These are decisions where I don't want to guess on your behalf:

1. **Path selection (A vs B vs C above)** — the single most consequential call. Source-first defers AI validation; view-first ships faster but reads thinner source data; hybrid threads the needle. My lean is C; this is yours to set.
2. **Themes (A2):** worth the build, or too much ceremony for a solo app? If yes, monthly cadence or set-and-forget? (Also: until A2 ships, V3 can heuristically infer themes — so this is more about whether you want first-class theme-tracking UX in the app, not whether the observer can use themes.)
3. **`quick_capture` (A3):** discoverable button on the dashboard, or only via PWA shortcut / keyboard / voice? The capture-friction story matters.
4. **Voice capture:** [ROADMAP Phase 4](./ROADMAP.md) lists this. Worth bringing forward to land alongside A3? Voice-to-text is the fastest way to get the journal-text density that the observer actually feeds on.
5. **What to do with the `mood`/`content` random sampling?** Re-enable with mandatory text, or kill them off cleanly?

## A note on the broader feedback loop

The experiment also surfaced something not about the data shape but about the *loop* itself. The observer's best moves were structural: "the evening session doesn't ask about the morning intention," "you named three hard things and didn't return to any of them." A passive weekly digest can only mention that; a *living* observer would close the loop by pushing those threads back into tomorrow's morning session. ("Last week you named three intentions and reflected on one. Want to set today's intention with that pattern in mind?")

That's a Phase 2.5 feature, not a Phase 2 one. But worth keeping in mind that the eventual ceiling for this product isn't "Claude tells you what it saw" — it's "Claude makes the daily loop self-correcting." The data collection changes in this doc are mostly upstream prep for that ceiling.
