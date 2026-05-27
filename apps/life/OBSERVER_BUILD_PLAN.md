# Observer Build Plan

Tactical execution plan for the Phase 2 AI observer in the life app. The strategic context lives in [DATA_COLLECTION.md](./DATA_COLLECTION.md); the long-term direction lives in [ROADMAP.md](./ROADMAP.md). This doc owns "what we're doing this week and why," driven by a daily autonomous PM check-in.

**Owner:** PM-Claude (autonomous, daily 6am PT cron). User can redirect at any time by editing this doc, replying in chat, or canceling the cron.

**Last updated:** 2026-05-27 by initial plan write.

## Decisions made

Each decision below was made unilaterally by PM-Claude. User can reverse any of them; if reversed, log it in the **Decision log** at the bottom rather than just editing the decision in place — keeps the history of why we're where we are.

| # | Decision | Rationale | Date |
|---|---|---|---|
| 1 | Take **Path C (hybrid)** from DATA_COLLECTION.md's Concrete First Cuts. | Source-first defers AI validation indefinitely; view-first ships AI but reads thin source data. Hybrid does the cheapest bits of both, and the view-layer cleanup is what makes shipping a v0 observer credible against today's source. | 2026-05-27 |
| 2 | Phase 0 = MVP observer loop only. Defer V1/V2/V7/A3 to Phase 0.5+. | Smaller scope = faster to first real observation = faster learning loop. Quality items can come in after the first weekly fire lands and we read what's actually missing. | 2026-05-27 |
| 3 | **Weekly** observer cadence, Sunday afternoon firing. | Roadmap default. Daily would be noise (user has daily morning/evening already); monthly too sparse to learn from. Sunday afternoon lands when user is most likely in reflection mode. | 2026-05-27 |
| 4 | PM check-in: **daily 6am PT** during active build; drop to 2–3x/week once the loop is stable. | Daily appropriate for active build phase (lots to push). 6am PT = before user's morning session, so any dispatched worktree agent has hours to complete before user is active. The cron has explicit "no-op if nothing to do" semantics so it can't generate make-work. | 2026-05-27 |
| 5 | First worktree dispatch happens at the **next cron firing**, not in the conversation that wrote this plan. | Gives user a night to redirect. Establishes "cron is locus of work dispatch" pattern from day one. | 2026-05-27 |

## Phase 0 — MVP observer loop

**Goal:** by end of week, the loop is closed. A weekly cron fires, calls Anthropic on a real cross-source bundle, persists the observation, and surfaces it in the life app. First observation = first real signal on observation quality.

### Work items

Ordered by dispatch sequence. Each is a worktree-agent-sized chunk.

#### P0-1. PB collection + backend interface for `claude_observations`

- New migration `infra/pocketbase/pb_migrations/YYYYMMDD_HHMMSS_claude_observations.js` adding the collection (see ROADMAP Phase 2 for the schema sketch — `timestamp, content, period, data_window_start, data_window_end, related_event_ids[]`).
- New backend interface method(s) on a new `ObserverBackend` in `packages/backend/src/interfaces/`, plus PB impl in `packages/backend/src/pocketbase/`.
- Wire through `BackendProvider`.
- **Status:** pending dispatch.
- **Dispatch trigger:** first cron firing (or sooner if user explicitly asks).

#### P0-2. View-layer bundle module

- New `services/api/src/lib/observer/bundle.ts`. Functions to assemble the cross-source narrative document from `life_events`, `cooking_log`, `task_events`, active `travel_trips`. Output is markdown prose (V4 + V6 from DATA_COLLECTION.md).
- Unit tests in `services/api/src/lib/observer/bundle.test.ts` with fixture data covering: empty period (no events), text-heavy period (lots of journal text), trip-imminent period (active travel context).
- **Dependencies:** none — can run in parallel with P0-1.
- **Status:** pending dispatch.

#### P0-3. `POST /api/observations/generate` endpoint

- New route in `services/api/src/routes/observer.ts` (or extend `routes/data.ts` — agent's call).
- Accepts `{ period: "weekly"|"monthly"|"adhoc", window_start, window_end }`. Calls `bundle()`, sends to Anthropic API with the V0 system prompt (defined inline, versioned in code). Persists the result to `claude_observations`.
- New env var `ANTHROPIC_API_KEY` (add to `infra/k8s/api-secrets.yaml` as a placeholder + document the manual `kubectl create secret` step in `infra/k8s/README.md` if not already there).
- Add `@anthropic-ai/sdk` to `services/api/package.json`.
- **Dependencies:** P0-1 (collection must exist) + P0-2 (bundle to feed it).
- **Status:** pending dispatch.

#### P0-4. Weekly cron

- Kubernetes CronJob in `infra/k8s/cronjobs.yaml` firing Sunday 20:00 UTC (1pm PT — Sunday afternoon, matches roadmap).
- Curls `POST /api/observations/generate` with `period: "weekly"` and a window of the past 7 days.
- Same retention policy thinking as backups: keep all observations (low volume, high reflective value).
- **Dependencies:** P0-3.
- **Status:** pending dispatch.

#### P0-5. `/observations` view in life app

- New route `/observations` in `apps/life/app/src/`.
- Reverse-chronological list of observations + click-to-expand detail view.
- Pull data via the new `ObserverBackend`.
- Plus a single "Ask Claude about now" button on the dashboard that calls `POST /api/observations/generate` with `period: "adhoc"` and the past 14 days. (This is the "on-demand" half from ROADMAP Phase 2.)
- **Dependencies:** P0-1 (backend interface) + P0-3 (endpoint for adhoc).
- **Status:** pending dispatch.

### V0 system prompt (draft)

The first prompt that goes to Anthropic. Lives in `services/api/src/lib/observer/prompt.ts` so it's versioned. Iterate freely — change is cheap, no migration needed.

```
You are a thoughtful, observant friend reading someone's life-tracker data
from the past week. You see what they wrote (morning intentions, evening
reflections, journal entries), what they did (logged habits, cooking,
exercise, tasks), and the context (active travel, themes they've named).

Your job: produce 2-3 specific, honest observations and one good question.
Not a summary. Not a coach pep talk. Specific things you noticed.

Anti-patterns to avoid:
- Generic affirmations ("Great job exercising 3 times!")
- Restating their data back to them ("You logged 6 morning sessions")
- "Insights" that any tracker app could hardcode
- Loading them up with multiple questions

What works:
- Naming a thread that runs through multiple entries
- Flagging a stated intention that didn't get followed up
- Connecting something they wrote to something they did (or didn't do)
- Asking the one question that would push their thinking, not their guilt

Keep it under 200 words. Plain prose. No headers. No bullet points unless
the observations are genuinely list-shaped.
```

This is V0. Once the first real observations land, the prompt will iterate. **Hard rule:** never edit the prompt without writing the old version into the decision log first.

## Phase 0.5 — read and react (after first weekly fire)

The Sunday after Phase 0 ships, the cron fires and the first observation lands. Then:

1. Read the observation. Honestly evaluate it on the rubric we established in the original experiment (sharp / generic / wrong / made you defensive).
2. Identify the single biggest content gap (e.g., "didn't see today's cooking activity" or "missed that intent X wasn't addressed").
3. Decide whether the gap is fixable at the **view layer** (bundle missed something it should have included) or the **source layer** (data didn't exist to be included).
4. Dispatch the highest-leverage next item based on (3). Update this doc's Phase 1+ section with what we picked and why.

## Phase 1+ — TBD

To be filled in by Phase 0.5's findings. Candidates from DATA_COLLECTION.md (in rough priority but no commitments):

- **A3** (`quick_capture` event type) — if Phase 0.5 reveals the source has thin freeform text density
- **V7** (`/observations/preview` debug surface) — if Phase 0.5 reveals it's hard to tell what the bundle missed
- **V1 + V2** (empty-payload + duplicate scrubbing in view) — if first observations include junk
- **A4** (notes everywhere) — if numeric events are showing up unannotated and that's a problem
- **A2** (themes collection) — if observations would have been sharper with a stated horizon to compare against
- **A5** (timestamp precision) — if the observer is making false time-of-day claims

## Daily wakeup protocol (what the cron does)

The cron fires every day at 6am PT. Fresh Claude session. Has access to the homelab repo, MCP tools, the schedule, and dispatch ability. The prompt runs the following protocol:

1. **Read state.** `cat apps/life/OBSERVER_BUILD_PLAN.md` (this doc). `cat apps/life/DATA_COLLECTION.md`. `git log --oneline -10`. Check current branch state.
2. **Check in-flight work.** Are there active worktree branches (`git worktree list`)? Any agents still running? If yes, peek at status. Don't dispatch new work on top of in-flight work without coordination.
3. **Check fresh signal.** Did a new observation land since the last check-in? (`list_observations` once that MCP tool exists; for now, check `claude_observations` collection via a curl to the api.) If yes, follow the Phase 0.5 protocol on it.
4. **Decide today's action.** Exactly one of:
   - **Dispatch.** A worktree agent for the next pending P0 item (or P1+ item once we're past P0). Brief the agent thoroughly per the established pattern (worktree-init first, scope tightly, critical-review afterward).
   - **Evaluate.** Read a freshly-shipped observation; update the plan based on what's gappy.
   - **Update the plan.** Move items between phases, log a decision, etc.
   - **No-op.** Nothing useful to do today. Report briefly in the log and stop. *This is a valid and important outcome — don't make work.*
5. **Update this doc.** Append to the **Daily log** below: one line per day, format `YYYY-MM-DD: <action> — <one-sentence outcome>`. Commit the doc update.
6. **Stay within budget.** Each daily check has a soft cap of 30 minutes of agent time. If a task would clearly take longer, dispatch it (which uses parallel budget) and end the daily check.

## Daily log

| Date | Action | Outcome |
|---|---|---|
| 2026-05-27 | Initial plan write (in conversation, not cron) | Plan doc created; cron set up; first dispatch will happen at 2026-05-28 06:00 PT firing |

## Decision log

Append-only. When a decision in the table above gets reversed, log it here.

(empty)

## How the cron is wired (local, not remote)

The user chose local cron over the Anthropic-cloud routine path because the cron-fired session needs access to things only available locally:
- The homelab MCP server (tailnet-only — `mcp.tail56ca88.ts.net`)
- The k3s cluster (via `kubectl`) for inspecting PB / api state
- The Agent tool with `isolation: "worktree"` for dispatching sub-agents per the established repo pattern

### Wiring

- **Schedule:** crontab entry `0 6 * * *` (6am PT, local time). DST-safe — cron uses wall-clock local time, not UTC offset.
- **Wrapper:** [`infra/scripts/observer-pm-tick.sh`](../../infra/scripts/observer-pm-tick.sh) — runs `claude --print --max-budget-usd 5 --dangerously-skip-permissions --no-session-persistence` against the prompt file. Logs to `~/.local/share/observer-pm/tick-<utc>.log` with 30-day rotation.
- **Prompt:** [`infra/scripts/observer-pm-prompt.md`](../../infra/scripts/observer-pm-prompt.md) — the full self-contained daily wakeup protocol that the cron-fired Claude reads (since it has no memory of prior firings).

### Cron daemon lifecycle

WSL2 doesn't run systemd by default, so the cron daemon must be started manually. One-time and per-boot setup:

```bash
# One-time: start cron now (will run until WSL shuts down or restarts).
sudo service cron start

# Optional but recommended: make cron auto-start on every WSL boot.
# Edit /etc/wsl.conf (as root) and add:
#   [boot]
#   command="service cron start"
# Then `wsl --shutdown` from Windows and reopen WSL to take effect.
```

If cron is not running on a given day, the tick is silently skipped. Worst case: skipped days produce gaps in the daily log; no data is lost or corrupted. Check status with `pgrep cron` or `service cron status`.

### Manual fire (for testing or out-of-band ticks)

```bash
bash /home/skirklin/projects/homelab/infra/scripts/observer-pm-tick.sh
```

Same script, same prompt, same logs — just invoked by you instead of cron. Useful for debugging the wrapper or forcing an extra check-in.

## How to redirect the autonomous PM

If at any time you (user) want to change direction:
- **Edit this doc.** The next cron firing reads it. Add a `## INTERRUPT` section at the very top with explicit instructions ("stop dispatching, do X instead") and the cron will see it (the protocol step 1 explicitly checks for an INTERRUPT block).
- **Reply in chat** during a foreground session — the cron's last action is in the Daily log.
- **Pause the cron:** `crontab -e` and comment out the line. Save. Resume by uncommenting.
- **Cancel entirely:** `crontab -e` and delete the line. The wrapper script and prompt file stay in the repo for future re-arm.
- **Inspect logs:** `ls -lt ~/.local/share/observer-pm/ | head -5` for recent ticks; cat the latest to see what the cron did.
