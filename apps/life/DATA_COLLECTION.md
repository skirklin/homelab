# Data collection for the AI observer feedback loop

Written 2026-05-27, after running a one-shot observer experiment on 14 days of real data ([life-app session 2026-05-27](../../README.md)). Two audiences:
- **Scott** — strategic framing on what to invest in before Phase 2 of the [roadmap](./ROADMAP.md) is worth shipping
- **Life-app agent** — concrete, file-grounded recommendations for the next data-collection changes

Both audiences should read everything; the labels just say who each recommendation is primarily aimed at.

## What the experiment actually proved

Four observation styles ("Sunday letter," "sharp observer," "pattern hunter," "reflection prompter") were run by a Claude session with MCP access, on the user's real `life_events` for May 13–27, 2026. Two of four produced something worth reading. **All of the load-bearing insight came from the journal text fields** (`gratitude`, `intention`, `win`, `lesson`). **None of it came from the numeric trackers.**

That's not a bug in the experiment — it's a structural fact about what LLM observers are good at. An LLM reads language. With 14 days of single-user data, there is no statistical pattern in coffee/sleep/edibles numbers for any tool to find. Even with 6 months of data, finding "you sleep worse after edibles" is a stats job, not a language-model job.

The implication: **the AI observer is a journal reader, not a habit-data analyst.** The right product is one where the model reads what you wrote and connects it across days. The numeric trackers serve the dashboard, the streak, and the heatmap — they don't feed the observer.

## What the AI observer needs to do its job well

In rough priority order (highest leverage first):

1. **More text, with structure.** Morning intentions, evening reflections, weekly reviews — every text field is high-value. The observer's best move was "you wrote X as a morning intention three times and never came back to it."
2. **Continuity between entries.** The observer caught that morning intentions don't get pulled forward to evening reflection. That's a *language* problem — the app doesn't carry intent across sessions. Fixing it inside today's wizards (no AI involvement) is one of the highest-value changes available.
3. **Stated themes / horizons.** "This season is about physical rehab." "This year's theme is presence over autopilot." Without a named horizon, observations are just descriptive; with one, observations become "you said X, you did Y, here's the gap."
4. **Light context on numeric events.** A coffee entry alone is noise. A coffee entry tagged `pre_workout: true` is signal. The schema supports this (`labels`) — the UI doesn't surface it.
5. **Honest sparseness.** "I didn't log this" vs "I did this and it was zero" vs "I skipped this on purpose" are three different things. Currently all three look identical in the data.

The next four sections are recommendations bucketed by direction: things to **add**, things to **fix**, things to **drop**, and things to **not build**.

## Add

### A1. Pull morning intent forward into the evening session — wizard only, no AI

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

### A2. Add a `themes` collection — what's the season about?

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

### A3. Adopt a free-form `quick_capture` event type

> Audience: both. Modest build, big payoff for the observer.

Today's data shape forces every event into a named trackable. If you have a thought at 2pm — "I'm noticing I've been irritable since the Mexico trip got real" — there's no slot for it. The morning/evening sessions are the only freeform-text containers, and they're once-a-day, time-locked, and prompt-bound.

A `quick_capture` event with one freeform `text` entry, plus optional tags, is the missing capture surface. One button on the dashboard, a 30-second flow. Implementation can reuse the existing event pipeline (`subject_id: "quick_capture"`, `entries: [{name: "text", type: "text", value: "…"}]`).

This is the single fastest way to grow the observer's signal density without adding new numeric trackers.

### A4. Make `notes` ubiquitous, optional, and one tap away

> Audience: agent

Several trackables already support `hasNotes: true` (sleep does — [trackables.ts:89](app/src/trackables.ts#L89)). Extend the pattern so that *any* trackable's full-form view can attach an optional note. Cost: small. Value to the observer: large. A coffee at 11pm with the note "couldn't focus, anxious about house stuff" is the kind of event that ties the numeric and text data together — and produces an observation neither would produce alone.

Don't require notes; just make them frictionless when the user has one.

### A5. Capture the *time* on real-time logs, capture only the *date* on backfills

> Audience: agent

The data has many entries with timestamp `19:00:00.000Z` — clearly synthetic, generated by some backfill UI defaulting to midnight-PT. This destroys any time-of-day analysis. Two changes:

1. When the user logs an event "now," capture the actual timestamp (already happens for some entries — the recent ones with millisecond precision).
2. When the user backfills "yesterday" or any other day, **store the date but mark the time as unknown** (e.g., `timestamp_precision: "day"` on labels, or omit time entirely if the schema can express that). Don't fabricate `19:00:00`.

The observer can then say "you exercised most often in the evenings this month" *truthfully*. Today it can't.

## Fix

### F1. Stop generating empty-payload entries

> Audience: agent. This is the biggest data-hygiene problem.

In the 14-day sample, ~10 entries had `entries: []` — coffee/sleep/poop/mood/content events with no value. These came from a UI path where the user tapped "log" without committing a value (or canceled a form mid-edit, or the random-sample popover wrote-then-skipped). They're indistinguishable from real logs and they actively poison observation: the observer sees "8 sleep events in 14 days" when really there are 3 with data.

Two fixes, in order of preference:

1. **Don't write the event if no values are present.** Treat a value-less submission as a no-op, not a submission. (Preferred.)
2. If there's a real reason to record a "tapped but skipped" event, give it a different `subject_id` (e.g., `<subject>_prompt_dismissed`) so it doesn't pollute the canonical trackable's data.

Audit every code path that calls `addLifeEntry` and check whether the entries array can be empty at write time.

### F2. Unit-confusion guard on sleep (and any duration trackable)

> Audience: agent. Small but real.

`life_events.id: dhkdz3m0v3v2hye` on May 26 has `value: 8, unit: "min"` — clearly meant 8 hours = 480 minutes. The inline form already auto-switches to hours input when `defaultValue >= 60` ([trackables.ts:87](app/src/trackables.ts#L87)), but something allowed an 8-minute sleep entry through. Either the conversion isn't happening on submit, or there's a code path (preset chip? backfill?) that bypasses it.

Add a sanity range on write: a sleep entry < 60 minutes triggers a confirm modal — "you slept for 8 minutes?" — and if confirmed, persists with a `labels.confirmed_outlier: true` flag so the observer knows it's intentional. Otherwise: re-prompt.

Same pattern for any time-based trackable with `defaultValue >= 60`.

### F3. Distinguish "missed" from "skipped" from "zero"

> Audience: agent + Scott (decide if the distinction matters)

Sleep wasn't logged on most days in the sample. Was that "didn't sleep" (zero), "forgot to log" (missed), or "chose to skip" (skipped)? The observer doesn't know, and conservatively treats them all as "no data." The truthful answer is almost always "forgot to log," but the app has no way to record that.

Minimum viable fix: a long-press on the dashboard card surfaces a "mark as skipped today" option. Writes a sentinel entry (`labels.skipped: true`, `entries: []`). Now the observer can say "you logged sleep 4 days and skipped 1 day; the other 9 are missing" instead of treating all 10 as missing.

Lower priority than F1; only worth doing once empty-payload entries are eliminated, so the sentinel is meaningful.

### F4. Patch the broken floss-delete UI

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

## Concrete first cuts for the agent

In order of leverage-per-hour, what to pick up next:

1. **A1** — pull morning intent into the evening session. Wizard change, no AI, no migration. Try to ship before the observer feature is even built; the wizard change alone improves the daily loop.
2. **F1** — eliminate empty-payload entries. Audit `addLifeEntry` call sites. ~1 hr.
3. **A3** — `quick_capture` event type + one button on the dashboard. Reuses existing pipeline. Mostly UI work. Probably the highest-impact single change for observer signal density.
4. **A4** — extend `hasNotes` to all trackables (opt-in, optional). One field, every trackable's full form.
5. **A5** — distinguish backfill-date from real-timestamp. Largest schema change in this list; defer until after the first three.
6. **F2** — sanity-range confirm on sleep duration. Small.
7. **A2** — themes collection. Net-new collection + a small UI. Defer until Phase 2 build starts; it's the anchor the observer prompt will read first.

After these, the May-2026 data collection surface is genuinely ready for an observer to work against. Until they're done, building Phase 2 ([claude_observations collection, /observations view, scheduled cron](./ROADMAP.md)) is premature — the observer will work, but the observations will be thinner than they should be because the *inputs* aren't carrying enough signal.

## Open questions for Scott

These are decisions where I don't want to guess on your behalf:

1. **Themes (A2):** worth the build, or too much ceremony for a solo app? If yes, monthly cadence or set-and-forget?
2. **`quick_capture` (A3):** discoverable button on the dashboard, or only via PWA shortcut / keyboard / voice? The capture-friction story matters.
3. **Voice capture:** [ROADMAP Phase 4](./ROADMAP.md) lists this. Worth bringing forward to land alongside A3? Voice-to-text is the fastest way to get the journal-text density that the observer actually feeds on.
4. **What to do with the `mood`/`content` random sampling?** Re-enable with mandatory text, or kill them off cleanly?

## A note on the broader feedback loop

The experiment also surfaced something not about the data shape but about the *loop* itself. The observer's best moves were structural: "the evening session doesn't ask about the morning intention," "you named three hard things and didn't return to any of them." A passive weekly digest can only mention that; a *living* observer would close the loop by pushing those threads back into tomorrow's morning session. ("Last week you named three intentions and reflected on one. Want to set today's intention with that pattern in mind?")

That's a Phase 2.5 feature, not a Phase 2 one. But worth keeping in mind that the eventual ceiling for this product isn't "Claude tells you what it saw" — it's "Claude makes the daily loop self-correcting." The data collection changes in this doc are mostly upstream prep for that ceiling.
