# Performance backlog

Latent algorithmic-performance issues found in the 2026-06-22 codebase-wide audit (4 parallel read-only audit agents). These "work because the data is small" — flagged for when data grows or a hot path starts to feel slow.

**Already fixed + shipped (2026-06-22, the "top cluster"):**
- `evaluateGoal` — buckets events once, O(events×366) → O(events+periods); + windowed server fetch on `/life/goals/progress`.
- Task outliner — memoized `allTasks` + `childrenByParentId` map; dropped per-keystroke O(n) scans + O(subtree×n) cascade.
- Recipe `Contents` — memoized the box×recipe flatten.
- Ingest institution/person detail — batched latest-balance (dropped N+1 per account).

Everything below is **deferred**. Severity reflects hot-path × growth, not current pain.

## MEDIUM — worth doing as data grows

- **`fetchParentIds` whole-collection scan** — [services/api/src/lib/notifications/recipients.ts](services/api/src/lib/notifications/recipients.ts). `getFullList` over all tasks every notification cron run. Per-cron (not per-request), so MEDIUM. Fix: scope to the lists in play, or maintain a has-children flag.
- ~~**`list_life_entries` / `GET /life/entries` unwindowed**~~ — DONE 2026-06-23. Route accepts `since`/`days`, pushes `timestamp >=` into the PB filter (cutoff bound as a `Date`, not ISO string — PB compares datetime params lexically). MCP tool passes `since`, dropped the JS post-filter.
- **MCP `search_recipes` N+1** — [services/api/src/mcp.ts:117](services/api/src/mcp.ts#L117). One `/recipes?boxId=` call per box + JS substring match. Fix: server-side `GET /recipes?q=` filtering the `data.name` JSON in one query.
- **MCP `search_travel` N+1** — [services/api/src/mcp.ts:381](services/api/src/mcp.ts#L381). 2 calls per log + JS match. Fix: push substring match into the PB query / add a search endpoint.
- **Task subtree mutations — serial awaited writes** — [services/api/src/routes/data.ts](services/api/src/routes/data.ts) (`move_task` reparent ~3171, `clear-done` ~3310, `delete` cascade ~3332) and the client adapter [packages/backend/src/pocketbase/upkeep.ts](packages/backend/src/pocketbase/upkeep.ts) (`deleteTask`/`moveTask` ~274/304). One sequential round-trip per descendant. Fix: chunked `Promise.all` (unique requestKey each) or a transactional cascade hook.
- **Sync engine: per-SSE-event materialize + contentHash full rescan** — [packages/backend/src/wrapped-pb/mirror.ts](packages/backend/src/wrapped-pb/mirror.ts) (`handleSseEvent` → `emitSlice` → `materialize` → `queue.viewCollection`, + `contentHash`). For a filter-only wildcard slice (e.g. shopping items), every realtime event re-scans the whole collection + re-stringifies all rows: O(events × list size) during sync bursts. Most invasive to fix — incremental/per-record hashing or a per-slice materialized cache. Latent until lists get large.
- **Ingest O(dates×accounts) forward-fill** — [services/ingest/src/money/server.py:417](services/ingest/src/money/server.py#L417) + ~525. Backs net-worth-history + performance charts (the dashboard's heaviest). Fix: k-way merge over each account's sorted points, or running-sum delta.
- ~~**Missing index `sync_history.institution`**~~ — DONE 2026-06-23. Added `idx_sync_history_institution(institution, status, finished_at)` to `schema.sql` + `db._migrate` (unconditional so existing prod DBs get it). **Follow-up (LOW):** `sync_history` still has no retention prune — grows ~12 rows/day forever. The index keeps lookups fast regardless, but a prune (keep last N per institution, or rows newer than ~90d) would bound the table if disk/row-count ever matters.
- **Ingest Chase txn↔account match: DB query in nested loop** — [services/ingest/src/money/ingest/chase.py:338](services/ingest/src/money/ingest/chase.py#L338). `get_account_by_external_id` inside O(T×D) loop. Fix: prebuild `{mask: account}` dict.
- **Travel `ItineraryCompare` O(itineraries×days×activities)** — [apps/travel/app/src/components/ItineraryCompare.tsx](apps/travel/app/src/components/ItineraryCompare.tsx) (`getDiff` ~200). `.includes` membership in a triple-nested render loop. Fix: precompute per-itinerary `Set` of activityIds in a memo.
- **Life HabitBoard / entries Map identity churn** — [apps/life/app/src/components/HabitBoard.tsx:392](apps/life/app/src/components/HabitBoard.tsx#L392) + Visualizations. `state.entries` Map identity changes every event, so `Array.from(...)` memos always recompute → cascades. The `evaluateGoal` fix helped the per-goal cost; the array-identity amplifier remains. Fix: stable array reference / reverse index in context; share one event-by-period index across goals; replace `trackables.find` with a Map.
- **Money CategoryChart / AllocationOverTime nested aggregation** — [apps/money/src/components/CategoryChart.tsx:93](apps/money/src/components/CategoryChart.tsx#L93), [AllocationOverTime.tsx:124](apps/money/src/components/AllocationOverTime.tsx#L124). O(categories×transactions) / O(accounts×months×classes) rebuilds. Fix: single accumulator pass.
- **Travel ReadinessDashboard `activities.find` in slot/flight maps** — [apps/travel/app/src/components/ReadinessDashboard.tsx](apps/travel/app/src/components/ReadinessDashboard.tsx) ~128/144/204. Fix: pass down the `activityMap` TripDetail already builds.
- **Life Insights `inferShape` full scan per orphan subject** — [apps/life/app/src/components/insights/model.ts](apps/life/app/src/components/insights/model.ts). Fix: one bucketing pass per subjectId.
- **Shopping add-item autocomplete** — [apps/shopping/app/src/components/AddItem.tsx:50](apps/shopping/app/src/components/AddItem.tsx#L50). Filters full suggestion set + rebuilds existing-items Set per keystroke. Fix: hoist the Set to its own memo; prefix-index if the corpus grows.

## LOW — fix only if touching the file / at real multi-user scale

- Life crons `getFullList` all `life_logs` per tick (per-minute) — [services/api/src/lib/notifications/life.ts:126](services/api/src/lib/notifications/life.ts#L126)/413. Single-user today. Add a top-level boolean column to filter idle logs if multi-user lands.
- `queue.gcTombstones` scans all records per fetch-settle — [packages/backend/src/wrapped-pb/queue.ts:221](packages/backend/src/wrapped-pb/queue.ts#L221). Scope GC to affected collections if the queue gets large.
- `chat_messages.thread_id` not indexed (covered by the owner+created index prefix) — add `(owner, thread_id, created DESC)` only if one owner accumulates many threads.
- Money AllocationChart / CategorySection / ShoppingTrips `.find` in maps; life TrendsView `percentileScale` per render — small-n, memoize/Map when nearby.

## Confirmed clean (audited, not findings)

PB hooks (cleanup hooks narrow per-delete, no full rescan), all 65 PB migrations (single-pass rewrites), the observer bundle (explicitly batched), money `TransactionTable` (memoized + debounced + capped 5000), upkeep `buildTree`/`groupTaskIds` (single-pass), most ingest parsers (dict/set joins, pre-compiled regexes).
