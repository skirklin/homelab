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
| 6 | **PM cron stays local (WSL crontab), not hosted on the VPS k3s cluster.** The actual weekly observer cron (P0-4) will be hosted — that's a separate decision. | The PM cron's job is to dispatch worktree-isolated sub-agents + iterate on the prompt/protocol. Both depend heavily on the local pattern (Agent tool with `isolation: "worktree"`, fast prompt iteration, easy log inspection). Hosted would force a PR-based workflow and a rebuild-redeploy cycle on every prompt tweak — strict regressions on the dimensions that matter most early. Failure mode (skipped day if WSL off) is harmless. **Revisit if:** user stops being at the laptop most days, protocol stabilizes (~4–8 weeks in), or non-Scott users start depending on the cadence. | 2026-05-27 |

## Phase 0 — MVP observer loop

**Goal:** by end of week, the loop is closed. A weekly cron fires, calls Anthropic on a real cross-source bundle, persists the observation, and surfaces it in the life app. First observation = first real signal on observation quality.

### Work items

Ordered by dispatch sequence. Each is a worktree-agent-sized chunk.

#### P0-1. PB collection + backend interface for `claude_observations`

- New migration `infra/pocketbase/pb_migrations/YYYYMMDD_HHMMSS_claude_observations.js` adding the collection (see ROADMAP Phase 2 for the schema sketch — `timestamp, content, period, data_window_start, data_window_end, related_event_ids[]`).
- New backend interface method(s) on a new `ObserverBackend` in `packages/backend/src/interfaces/`, plus PB impl in `packages/backend/src/pocketbase/`.
- Wire through `BackendProvider`.
- **Status:** ✓ MERGED 2026-05-27 (merge commit `30569e5`). Worktree `agent-a12b2f0c` (commits `7ebbedb` + `22c6b0d`). Critically reviewed, top 3 should-fixes applied before merge (authz mirror entries, idempotency guard, period enum). Deferred: index on owner, max on content (Phase 0.5).

#### P0-2. View-layer bundle module

- New `services/api/src/lib/observer/bundle.ts`. Functions to assemble the cross-source narrative document from `life_events`, `cooking_log`, `task_events`, active `travel_trips`. Output is markdown prose (V4 + V6 from DATA_COLLECTION.md).
- Unit tests in `services/api/src/lib/observer/bundle.test.ts` with fixture data covering: empty period (no events), text-heavy period (lots of journal text), trip-imminent period (active travel context).
- **Dependencies:** none — can run in parallel with P0-1.
- **Status:** ✓ MERGED 2026-05-27 (merge commit `10f05c6`). Worktree `agent-a0fa66fa` (commits `6f91a5d` + `a20a98b`). Critically reviewed, V4 per-day cross-source shape applied + top 3 technical should-fixes (timezone fallback to America/Los_Angeles, ISO yyyy-MM-dd day keys, batched lookups eliminating N+1) + V2 aggregation. Deferred: relatedEventIds field naming, silent fetcher error swallow, smell items (Phase 0.5).

#### P0-3. `POST /api/observations/generate` endpoint

- New route in `services/api/src/routes/observer.ts` (or extend `routes/data.ts` — agent's call).
- Accepts `{ period: "weekly"|"monthly"|"adhoc", window_start, window_end }`. Calls `bundle()`, sends to Anthropic API with the V0 system prompt (defined inline, versioned in code). Persists the result to `claude_observations`.
- New env var `ANTHROPIC_API_KEY` (add to `infra/k8s/api-secrets.yaml` as a placeholder + document the manual `kubectl create secret` step in `infra/k8s/README.md` if not already there).
- Add `@anthropic-ai/sdk` to `services/api/package.json`.
- **Dependencies:** P0-1 (collection must exist) + P0-2 (bundle to feed it).
- **Status:** ✓ MERGED 2026-05-29 (merge commit on main). Worktree `agent-a27ee4d1` (commit `ceca60b`). Critically reviewed — zero blockers, 3 should-fixes deferred (timezone pass-through, MCP timezone param, 401 test).

#### P0-4. Weekly cron

- Kubernetes CronJob in `infra/k8s/cronjobs.yaml` firing Sunday 20:00 UTC (1pm PT — Sunday afternoon, matches roadmap).
- Curls `POST /api/observations/generate` with `period: "weekly"` and a window of the past 7 days.
- Same retention policy thinking as backups: keep all observations (low volume, high reflective value).
- **Dependencies:** P0-3.
- **Status:** ✓ MERGED 2026-05-29 (merge commit `a1d3adf`). Worktree `agent-a9f8783a` (`e9d6596` + `51d7205`). Critically reviewed; one blocker fixed before merge (in-cluster URL had a stale `/fn` prefix → would 404 on first fire). Activates on next `kubectl apply` / deploy.

#### P0-5. `/observations` view in life app

- New route `/observations` in `apps/life/app/src/`.
- Reverse-chronological list of observations + click-to-expand detail view.
- Pull data via the new `ObserverBackend`.
- Plus a single "Ask Claude about now" button on the dashboard that calls `POST /api/observations/generate` with `period: "adhoc"` and the past 14 days. (This is the "on-demand" half from ROADMAP Phase 2.)
- **Dependencies:** P0-1 (backend interface) + P0-3 (endpoint for adhoc).
- **Status:** ✓ MERGED 2026-05-29 (merge commit `8a0e066`). Worktree `agent-ad5e5fc4` (`4c809f3`). Critically reviewed: 0 blockers. Deferred to Phase 0.5: component tests, post-generate refetch error is swallowed, markdown rendering (acceptable for v0 — prompt is prose-only).

**🎉 Phase 0 complete (2026-05-29): all five items merged. The observer loop is closed end-to-end — pending a deploy of `life` + `api` + the CronJob, plus a `claude_observations` PB migration apply.**

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

### Phase 0.5 queue — deferred items from P0-1 + P0-2 reviews

Logged here so tomorrow's tick (or later) can pick them up rather than letting them rot in review comments:

**From P0-1 review:**
- Add index on `claude_observations.owner` — observations are append-only and `listObservations` always filters by owner; full-table-scan as the collection grows
- Add `max` to `content` field — currently no ceiling, runaway loop could stuff arbitrary blobs

**From P0-2 review:**
- Rename `relatedEventIds` to `relatedLifeEventIds` (or widen the field to cover cross-source IDs) — current name is misleading since only life_events are populated
- Replace silent `try { ... } catch { return [] }` in fetchers with logged + surfaced errors — a PB 500 currently produces an "empty week" observation, the worst possible outcome
- Stale `shopping_history` entry in `0026_authz_strings_source_of_truth.js` (drift from `lib/authz-rules.js` which dropped it post-retire) — invisible to the drift test today; worth a sweep next time someone's in that file

**From P0-3 review:**
- Pass `timezone` through the generate endpoint (read from user record, fall back to `America/Los_Angeles`) — currently the bundle always uses the fallback TZ. Latent bug if timezone ever varies.
- Add `timezone` as optional param to the `generate_observation` MCP tool schema (mirrors above).
- Add a test for the `!userId → 401` branch in `observer.test.ts` — the guard exists but is untested.

**Test infra papercut surfaced today:**
- `infra/test-env.sh` derives port `8091 + cksum(basename) % 1000` for worktrees, so a worktree whose basename hashes to offset 0 lands on 8091 — the same port the main-checkout test env claims by default. Effect: that worktree's PB becomes the "main" test PB for any other process talking to 8091, including drift tests that don't have `PB_URL`/`PB_TEST_URL` set. P0-1's authz-mirror test failed against main exactly because of this (worktree `abe77d3ae76ebb63f` is holding 8091 with a stale PB that lacks the new migration). Possible fixes: skip offset 0 in the worktree port derivation, or make `getPbTestUrl()` fail loudly when neither env var is set rather than silently falling back to 8091.

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
| 2026-05-27 | DISPATCH P0-1 + P0-2 (first firing, parallel) | P0-1 (agent-a12b2f0c): PB migration + ObserverBackend + BackendProvider wiring. P0-2 (agent-a0fa66fa): bundle.ts + 4 unit tests. Both awaiting critical review. |
| 2026-05-27 | OOB tick (manual): critically-reviewed + addressed top should-fixes + MERGED P0-1 + P0-2 | P0-1 merge `30569e5` (added authz mirror entries, idempotency guard, period enum). P0-2 merge `10f05c6` (restructured to V4 per-day cross-source shape + tz fallback + ISO day keys + N+1 batched). Deferred items queued under Phase 1+. Test-infra papercut surfaced (worktree on port 8091 → main's drift test runs against stale PB). |
| 2026-05-27 | DISPATCH P0-1 + P0-2 (first firing, parallel) | P0-1 (`worktree-agent-a12b2f0c`): PB migration + ObserverBackend + BackendProvider wiring, typecheck clean. P0-2 (`worktree-agent-a0fa66fa`): bundle.ts + 4 unit tests, typecheck clean. Both need critical review before merge. |
| 2026-05-28 | DISPATCH P0-3 + critical review | P0-3 built in worktree `agent-a27ee4d1` (commit `ceca60b`): generate endpoint + prompt.ts + MCP tool + 9 tests. Review: 0 blockers, 3 should-fixes deferred. Ready to merge. |
| 2026-05-29 | MERGE P0-3 + DISPATCH P0-4 + P0-5 | Merged P0-3 to main. Dispatched P0-4 (weekly CronJob) and P0-5 (observations UI) in parallel — both agents running. |
| 2026-05-29 | OOB (in-conversation): critical-review + MERGE P0-4 + P0-5 → Phase 0 COMPLETE | Reviewed both deferred from the cron's budget edge. P0-4 had a blocker (stale `/fn` in-cluster URL) fixed before merge (`a1d3adf`). P0-5 clean, merged (`8a0e066`). All five Phase 0 items now on main; loop closed pending deploy. Should-fixes queued in Phase 1+. |
| 2026-05-29 | Scott asked for better PM↔user channel → designed + built Phase C v1 (C1+C2) | Diagnosed PM-runs-open-loop gap. Designed "Chat" v1 (flat chat-log, daily cron = responder, chat-shaped for additive realtime-SDK swap later). C1 (`8053f61`) + rename Coach→Chat + C2 `/chat` UI + dashboard entry (`7358525`) merged. Three should-fixes folded in pre-merge. Phase C is 2/4 done; C3 (push) + C4 (cron prompt — Scott to shape voice/questions/cadence) pending. |
| 2026-05-30 | DISPATCH C3 (push on assistant chat message) | Built in worktree `agent-ab53e515` (`a6ca8ef`). 15-line diff: fire-and-forget `sendPushToUser` after assistant POST. Reviewed inline — no blockers, ready to merge. Phase 0 + C1–C3 all built, pending deploy. |
| 2026-05-31 | MERGE C3 + NO-OP | Merged C3 to main. All Phase 0 + C1–C3 on main, pending deploy. C4 blocked on Scott's voice/cadence input. No new dispatches — nothing actionable until deploy or C4 direction. |
| 2026-06-01 | NO-OP | All built work (Phase 0 + C1–C3) still pending deploy; C4 still blocked on Scott's voice/cadence input; no observations to evaluate. |
| 2026-06-03 | NO-OP | Same as 6/1: all built work pending deploy; C4 blocked on Scott's input; no observations to evaluate; 5 stale worktrees could be reaped. |
| 2026-06-04 | NO-OP | Unchanged: Phase 0 + C1–C3 on main awaiting deploy; C4 blocked on Scott's input; no observations yet. |
| 2026-06-05 | NO-OP | Day 4 waiting: all built work on main awaiting deploy; C4 blocked on Scott's input; no observations to evaluate. |
| 2026-06-06 | NO-OP | Day 5 waiting: unchanged — Phase 0 + C1–C3 on main awaiting deploy; C4 blocked on Scott's input. |
| 2026-06-08 | NO-OP | Day 7 waiting: all built work on main awaiting deploy; C4 blocked on Scott's input; no observations to evaluate. |
| 2026-06-09 | NO-OP | Day 11 waiting: all built work on main awaiting deploy; 2 dirty worktrees from another session have in-flight thread_id work; C4 blocked on Scott's input. |
| 2026-06-11 | NO-OP | Day 13 waiting: Phase 0 + C1–C3 + D1–D3 all on main awaiting deploy; C4 blocked on Scott's input; 5 worktrees from other sessions active. |
| 2026-06-12 | DISPATCH morning-prompt rework + chat reply | **Deploy is LIVE** (chat_messages in prod with thread_id). Found unresolved 6/8 user message in pm thread: replace "one thing that matters" with a plan-for-the-day prompt (priorities, what/when, calendar). Dispatched worktree agent (keep `id: "intention"` join key, fix evening follow-up + SESSION_REMINDERS drift); replied in pm thread. Built (`2528404`), critically reviewed (0 blockers), MERGED to main same tick; worktree reaped. New wording: "What's the plan for today?" + evening "How did the plan hold up?". Pending deploy of life+api. Tomorrow: nudge deploy + check for first weekly observation. |
| 2026-06-13 | NO-OP | Waiting for first weekly observation (cron fires Sun 6/15 1pm PT). Morning-prompt rework on main, may need deploy. C4 blocked on Scott's input. 5 worktrees active from other sessions. |
| 2026-06-14 | NO-OP | Observer endpoint confirmed live in prod (400 on empty body). Weekly cron fires tomorrow Sun 6/15 1pm PT — first observation imminent. C4 blocked on Scott's input. |
| 2026-06-15 | NO-OP | Weekly cron fires today at 1pm PT — first observation will land in ~7h. Tomorrow's tick evaluates it under Phase 0.5. Six worktrees active from other sessions; none observer-related. |
| 2026-06-16 | NO-OP | Observer CronJob + claude_observations collection still not deployed; no observation landed. All built work on main awaiting deploy. C4 blocked on Scott's input. |
| 2026-06-17 | NO-OP | Endpoint is live (500 not 404) but `ANTHROPIC_API_KEY` missing from api-secrets; observer-weekly CronJob also not applied. Two specific blockers for Scott. |

## Decision log

Append-only. When a decision in the table above gets reversed, log it here.

(empty)

## Phase C — PM ↔ user channel ("Chat" v1)

> Renamed from "Coach" before any deploy; the user-facing name is "Chat". Collection / interface / hook / route / MCP tool names all use the "chat" stem.

**Why:** the PM agent runs open-loop — it can't deploy (needs Scott's 1Password + judgment), and it never asks whether what it shipped actually works. It writes to this log, which Scott has to come read. Requested 2026-05-29: a real bidirectional channel so the PM can (a) flag deploys it needs, (b) ask UX questions, (c) hear what's working / not. Same irony this project exists to fix — applied to the builder.

**Vision (Scott's framing):** the seed of a "personal health-coach chat" — eventually a realtime chat to a Claude agent with full access to his data ("like the Google Health coach, but mine"). v1 is async (daily cron = responder); the realtime upgrade is future-not-now (see note).

**v1 design — a flat chat log:**
- Collection `chat_messages` — owner-scoped, chat-shaped: `{owner, role: "assistant"|"user", body (markdown), kind: "chat"|"question"|"deploy_request"|"feedback"|"note" (default "chat"), resolved (bool), meta (json), created}`. MUST be added to the authz mirror (`lib/authz-rules.js` + `0026` inline copy + a `userOwnsChatMessage` helper) — bake this in from the start; it was the should-fix we caught late on P0-1.
- The "assistant" is the **daily PM cron** for now (latency up to a day; faster if Scott triggers a tick). The chat-log shape is chosen so the future realtime responder is an additive swap, not a rewrite.
- Scott posts; the next tick reads recent messages, answers open ones, posts deploy-requests + 1–2 UX questions about recently shipped features.

**Work items:**
- **C1 — collection + backend + MCP tools** (foundation; everything depends on it). `chat_messages` migration (+ authz mirror), `ChatBackend` interface + PB impl + `useChatBackend()`, and MCP tools `list_chat_messages` / `post_chat_message` / `resolve_chat_message`. **Status: ✓ MERGED 2026-05-29 (merge commit `8053f61`).** Worktree `agent-ae65f76c601a0b61d` (commit `b40f572`). Critically reviewed clean. Authz mirror baked in from start.
- **C2 — `/chat` chat UI in the life app.** Timeline (assistant/user), compose box, resolve affordance, dashboard entry point + unread badge. Markdown render (react-markdown). **Status: ✓ MERGED 2026-05-29 (merge commit `7358525`).** Worktree `agent-adc78f2fede7f1d82` (commits `8d786f6` rename + `dbf71ff` UI + `1991be2` should-fixes). Renamed "Coach" → "Chat" pre-deploy in the same branch. Critically reviewed; 3 should-fixes applied before merge (iOS PWA viewport via `100dvh`, unread badge cap 100→500, phantom-duplicate on refetch-failure → POST-response inline swap).
- **C3 — push nudge.** When the assistant posts, fire a push (reuse VAPID infra) so Scott sees it rather than discovering it in-app. **Status: ✓ MERGED 2026-05-31 (merge to main). Worktree `agent-ab53e515` (commit `a6ca8ef`). Reviewed clean.**
- **C4 — cron prompt update.** Each tick: read chat messages since last tick → answer unaddressed user messages → post deploy-requests for merged-but-undeployed work → ask 1–2 UX questions about recent ships. User-facing comms move to Chat; the daily log stays as internal cron state. **Status: pending — Scott should shape the prompt (assistant's voice / what UX questions to ask / cadence) before this is dispatched.**

**Note: the channel only goes live after a deploy** (UI + collection + MCP must reach prod) — bootstrapping the deploy-nudge channel itself requires a manual deploy.

### Future work (noted 2026-05-29 — DO NOT build yet)
- ~~**Realtime Chat via a Claude Code SDK service.**~~ **→ promoted to Phase D below (2026-06-08).** The June 15 2026 Anthropic billing change opened subscription credit pool to Agent SDK use, removing the cost-uncertainty that justified deferring. Scott also surfaced the gap directly: observations end with questions that invite engagement but the surface is read-only.

## Phase D — Realtime Coach Agent (Claude Agent SDK harness)

**Why now:** the observer ends its observations with questions ("which thread are you avoiding?") but there's no way to engage. Either drop the questions or make them interactive — Scott picked interactive, and specifically synchronous-realtime rather than cron-async (which would feel broken). This is the realtime coach that was Phase C's named-future-work, brought forward.

**Architecture (synthesized from 2026-06-08 research, both raw briefs in conversation history):**

- **Shape:** long-running k3s pod (`services/coach/`) holding a streaming-input `query()` from `@anthropic-ai/claude-agent-sdk`. The pod subscribes to PB realtime on `chat_messages` (filter `role="user"`) — every UI tab already learns about new messages via this channel, so the agent becomes just another subscriber. No PB hook, no webhook plumbing.
- **Session state:** custom `SessionStore` adapter mirroring SDK state to a new `coach_sessions` PB collection. Pod can restart anytime; conversation resumes from PB.
- **Tools:** homelab MCP via Streamable HTTP (configured programmatically via `mcpServers` option, NOT `.mcp.json`) + Anthropic's hosted web search (`{type: "web_search_20250305"}`, pay-per-query, no MCP). Tool allowlist via SDK's `allowedTools`/`disallowedTools` to block destructive ops by default.
- **Auth:** prefer `CLAUDE_CODE_OAUTH_TOKEN` (subscription-credit billing on Max — likely $0 marginal cost), fall back to `ANTHROPIC_API_KEY` (pay-per-token). Probe the OAuth path before committing to it for cost-modeling.
- **What does NOT change:** the daily PM cron stays as-is. Different concern (build management, not coaching). The Chat UI shipped in C2 stays as-is (refetches via existing PB realtime; agent assistant messages just appear).

**Work items:**

- **D1 — Foundation: PB collection + SessionStore + service scaffolding** (this commit). `coach_sessions` migration + authz mirror + `userOwnsCoachSession` helper. New `services/coach/` directory with Hono health-endpoint stub, Dockerfile, k8s Deployment + Service manifest, `infra/deploy.sh` SERVICE_BUILDS entry, `gatus-config` check, secret stubs in `api-secrets`. Custom `PocketBaseSessionStore` class implementing the SDK's `SessionStore` interface. **No SDK loop yet** — pure scaffolding so D2 can fill in the agent logic. **Status: ✓ MERGED 2026-06-08 (merge commit `caa1156`).** Worktree `agent-a5f10a12336f4a7a0` (commit `3be64ed`). Critically reviewed clean; SDK signature discovered to differ from initial brief and adapted (SessionKey uses `subpath` not `subkey`; `append` takes batched entries; UUID is the idempotency key — agent caught and matched). SDK pinned to `@anthropic-ai/claude-agent-sdk@0.3.168`.

- **D2 — SDK loop + chat integration.** Wire up `query()` with streaming-input mode + inbox queue. PB realtime subscription to `chat_messages`. System prompt (chat-shaped variant of observer's prompt). Bundle warm-context on session boot (reuse `services/api/src/lib/observer/bundle.ts`). Assistant message writeback via existing `post_chat_message` route. Programmatic MCP config pointing at `mcp.tail56ca88.ts.net/mcp` with `HOMELAB_API_TOKEN`. Anthropic web search tool. Tool allowlist enforcement. **Status: ✓ MERGED 2026-06-08 (merge commit `0497bd8`).** Worktree `agent-af32296135a650438` (commits `2d9b795` + `4403c3a`). Critically reviewed; two should-fixes applied before merge (`getOrCreateSession` race → inflight promise Map; `allowedTools` ≠ restriction → added `tools: ["WebSearch", "WebFetch"]`). Plus the per-pod warm-context semantic gap (PB-lookup hasPrior silently skipped warm context after every restart) → in-memory `primedThisPod` Set. Plus bundle tenancy: `assembleBundle` gained optional `ownerId` param + `ownerFilter` helper handling both single-relation and multi-relation parents. **Voice:** sparse, per Scott's pick.

**Known v2 work** (deferred from D2):
- SDK `resume: sessionId` for cross-restart transcript continuity. Today the SDK starts fresh per pod and warm-context is the bridge — agent doesn't have prior conversation context after a restart. The `coach_sessions` mirror has it, but the SDK doesn't load it back. Reviewer judged this acceptable for single-user v1.
- Token-by-token streaming back to the UI.
- Per-user writeback tokens for multi-tenant (today single Bearer = single owner stamped server-side).
- Bundle path import is a Dockerfile-COPY hack (`infra/docker/coach.Dockerfile` copies `services/api/src/lib/observer/{bundle,tz}.ts`). Cleaner: promote to `packages/observer-bundle/`.

- **D3 — Frontend handoff: Observations → Chat.** Add "Continue this in Chat" button on each observation card in `Observations.tsx`. Button navigates to `/chat?observation=<id>`. `Chat.tsx` on mount with that param fetches the observation and prefills the compose box with a markdown-quoted version (lighter touch than the originally-briefed auto-post-as-assistant-message; user retains agency, no dedup needed, no DB writes from the button). **Status: ✓ MERGED 2026-06-08 (merge commit `ddf99dc`).** Worktree `agent-a4acc51135dc2292c` (commit `137bb00`). Tested clean (63/63 life-app vitest); merge done by eyeball-review rather than full critical-reviewer dispatch (frontend-only, established URL-param pattern from LifeDashboard, real test coverage of mount + scrub + draft-preservation + 404 paths).

**🎉 Phase D complete (2026-06-08): D1 + D2 + D3 all merged. The realtime coach loop is on main end-to-end pending deploy + secrets.**

**Deferred to v2 (not blocking v1):**
- Streaming output (tokens appearing as generated). v1 = full reply lands when ready, ~3-8s.
- Gmail + Calendar MCP servers as OAuth-authenticated clients.
- Per-token MCP scopes on the homelab server (defense-in-depth beyond SDK `allowedTools`).
- "Good morning" CronJob → `coach/morning` for unsolicited daily check-ins.
- `claude_observations`-reactive loop ("I notice last week's observation flagged X — want to talk?").
- `propose_delete` approval pattern for destructive writes (using existing `kind: "deploy_request"` chat message shape).

## How the cron is wired (local, not remote)

The user chose local cron over the Anthropic-cloud routine path because the cron-fired session needs access to things only available locally:
- The homelab MCP server (`mcp.kirkl.in` public, also `mcp.tail56ca88.ts.net` on tailnet)
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
