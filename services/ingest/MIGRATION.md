# Money → PocketBase migration plan

**Status:** deferred — see `/services/api/src/routes/money.ts` for the interim MCP proxy.
**Goal:** retire ingest's sqlite as the system of record. Money joins the `@homelab/backend` pattern (PB collections + typed adapter + optimistic wpb), unifying auth, backup, sharing, MCP, and frontend ergonomics with the other apps.
**Estimated effort:** ~2–3 weeks focused work.

## Why not done now
The proxy gives MCP access in half a day with zero risk to financial data. Migration is real architectural work and worth doing deliberately, not under MCP-feature pressure.

## What changes / what stays
- **Moves to PB:** all data currently in sqlite — `accounts`, `balances`, `transactions`, `holdings`, `performance_history`, `option_grants`, `private_valuations`, `ingestion_log`, `sync_history`, `transaction_tags`, `recurring_patterns`, `suggested_rules`, `suggested_rule_matches` (13 tables).
- **Stays in Python:** scraping (Playwright), aggregation logic (`suggest.py`, `categorize.py`, `recurring.py`, `benchmarks.py`, `calendar.py` — ~2k lines of business logic), CLI orchestration. Python becomes a **writer** to PB instead of an authoritative store.

## Workstreams

### 1. Schema (1–2 days)
- New PB migration file(s) under `infra/pocketbase/pb_migrations/` mirroring `db.py` schema.
- Snake_case field names per repo convention.
- Decisions to lock in:
  - **Time-series tables** (`performance_history`, `balances` snapshots): index on `(account_id, date)`. Verify query speed at realistic row counts (years × accounts) before committing.
  - **Transactions**: `category_path` is a slash-delimited hierarchy; keep as a string field with `like` queries, or split into a relation? Keep as string for v1.
  - **Computed/derived data** (e.g. `net_worth_history`): precomputed snapshots written by Python, or computed on read in TS? Lean precomputed — simpler reads, but Python becomes the single source of derived truth.

### 2. Backend abstraction (2–3 days)
- New `interfaces/money.ts` defining `MoneyBackend` (mirrors existing `RecipesBackend`, `TravelBackend` shapes).
- `pocketbase/money.ts` implementation.
- Snake_case ↔ camelCase mapper functions per record type.
- Wire into `BackendProvider` in `@kirkl/shared`.
- Cache decorator if needed.

### 3. Frontend rewrite (2–3 days)
- `apps/money/src/api.ts` (currently raw `fetch` to `/api/...`) → replace with `useMoneyBackend()` hook returning typed methods.
- Components that consume the api re-point at the backend.
- Optimistic UI via wpb comes for free once routed through the backend.
- Verify all current views (net-worth, accounts, transactions, holdings, performance, allocation, spending, recurring) still render.

### 4. Ingest write-path rewrite (3–5 days) — the hard part
- Python stops writing to local sqlite.
- Two options for the new write path:
  - **(a) Direct to PB REST API** with an admin token in a k8s secret. Simplest. Python serializes records and POSTs to PB collections.
  - **(b) Through the api service.** More layers, but auth/validation uniform with how the frontend writes.
  - Lean **(a)** — fewer hops, ingest is already a trusted in-cluster service.
- Aggregation: `suggest.py` writes its `suggested_rules` + `suggested_rule_matches` to PB after each run. `recurring.py` writes detected patterns. `benchmarks.py` writes benchmark series. `calendar.py` writes nothing (read-only consumer).
- Sync orchestrator in `cli.py` writes `sync_history` rows.

### 5. Data migration (1 day)
- One-time export script: read sqlite, POST to PB.
- Idempotent (use sqlite row IDs as PB IDs where possible).
- Snapshot sqlite before running. Migration is not designed to be reversed.

### 6. Cleanup (1–2 days)
- Remove `server.py`'s HTTP API once frontend is fully on PB.
- Keep `server.py` only for the scraping orchestrator endpoints (sync triggers, extension upload) and `health`.
- Retire `mcp_server.py` (the existing Python MCP) in favor of TS MCP through PB.
- Update `CLAUDE.md` to reflect new architecture.

## Risks
- **Time-series performance.** PB isn't a time-series DB. Years of daily balances × dozens of accounts = lots of rows. Validate with a load test on `performance_history` and `balances` snapshots before committing — falling back means a redesign.
- **Categorization regressions.** `suggest.py` is 562 lines of Python heuristics. If migration changes the order/timing of categorization runs (e.g. now writing to PB instead of sqlite), subtle behavior differences could silently degrade categorization quality. Snapshot a categorization comparison before/after.
- **Reversibility.** Once Python writes to PB and you tear down sqlite, going back is painful. Keep the sqlite snapshot + the data-migration script archived for at least a month post-cutover.
- **Two-system debugging.** During the cutover window, both sqlite (old) and PB (new) hold data. A scraping bug means debugging two stores at once. Plan a hard cutover, not gradual.

## Unlocks (the case for doing it)
- Money joins the optimistic-write / offline-cache pattern (no spinners, like shopping/recipes).
- Sharing / multi-user becomes structural (today, ingest assumes single user).
- Backup story unified — PB backup covers everything; sqlite goes away.
- MCP integration is structural, not a special case; future MCP features work automatically.
- Frontend can move off tailnet-only (tokens gate it) if you ever want remote access.
- Future features (annotations, household sharing, public dashboards) join existing patterns instead of inventing new ones.

## Suggested kickoff
1. Day 0: write the schema migration. Don't apply it yet.
2. Day 1: build a parallel write path in Python — every sqlite write also POSTs to PB.
3. Day 2–3: backfill data migration runs idempotently.
4. Day 4+: build the MoneyBackend + frontend rewrite against PB-populated data (sqlite is still authoritative).
5. Cutover day: stop sqlite writes; PB becomes authoritative; remove old HTTP API.

This gives a working PB-backed system in parallel before any irreversible change.
