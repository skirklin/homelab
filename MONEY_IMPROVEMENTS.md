# Money / Ingest improvements punch list

Derived from the 2026-05-13 multi-agent code review (server design, extension,
data model, tests, tooling). Ordered by leverage. **Do testing first** so that
later functional changes ship with a real safety net.

## Tier 1 — high leverage, low cost

### Testing (do these first)

- [x] **T1. Fix `services/ingest/tests/conftest.py:5` import failure.** Currently
  fails with `ModuleNotFoundError: No module named 'money'` on a clean
  checkout, so `uv run pytest` can't collect anything. Tests gate nothing
  until this works from a fresh clone. (Done: `pythonpath = ["src"]` under
  `[tool.pytest.ini_options]` in `pyproject.toml`, commit e165a78.)
- [x] **T1.5. One-command test entry point.** `pnpm test:ingest` from repo
  root handles the `VIRTUAL_ENV` poisoning workaround
  (`env -u VIRTUAL_ENV uv sync --group dev && uv run pytest`). Extra args
  pass through to pytest. See `services/ingest/README.md`.
- [x] **T2. Add `.github/workflows/test.yml`** running `uv run pytest` on push
  and PR for `services/ingest/`. Tests must gate merges. (Done: commit 1127aaa.)
- [x] **T3. Delete the bug-codifying assertion** at
  [services/ingest/tests/test_identity.py:47][ti47]
  (`test_ally_returns_none_without_login_entry`). It asserts the very bug
  shipped this morning as correct behavior. (Done: commit 2131ba6.)
- [x] **T4. Add a positive `customers/self` identity test** —
  `test_ally_identity_from_customers_self`: entry with
  `url=/acs/v3/customers/self`, `responseBody.data.emails=[{type:"PRIMARY",
  value:"x@y"}]`, assert `_extract_identity` returns the email. (Done: commit
  d41de52.)
- [x] **T5. Commit anonymized fixture captures** under
  `services/ingest/tests/fixtures/` so `test_parsers.py` and
  `test_identity.py` actually run in CI instead of `pytest.skip`-ing because
  the hardcoded `/home/skirklin/projects/money/.data` path doesn't exist.
  (Done: commits 946e8be, b00be4c, bc4ad8f, 38d484a — adds `scrub_fixture.py`,
  ally/wealthfront/capital_one fixtures, identity tests now run unconditionally.)
- [x] **T6. Add `test_capture_empty_entries_handled`** — POST `/capture` with
  `entries=[]`; assert either a 200 no-op or that empty quarantine files
  don't accumulate. The webNavigation race that fired today produced exactly
  this shape. (Done: commit 69c1040 — empty captures now return 200 no-op.)

### Server-side safety

- [x] **S1. Delete (or loud-warn) the "single login = unambiguous" fallback**
  at [services/ingest/src/money/server.py:1829-1832][srv1829]. It hides every
  identity-extraction bug until a second login appears.
- [ ] **S1.5. Delete single-login fallback** after chase/fidelity/morgan_stanley
  each have a working `_extract_identity`. Grep `kubectl logs deploy/ingest`
  for `IDENTITY_FALLBACK` to see how often it currently fires.
- [ ] **S2. Last-successful-capture watcher.** New PB collection / table:
  `(login_id, institution, last_success_at)`. Gatus check alerts when any
  configured login goes >24h without a successful capture. Closes the
  silent-rot class entirely (today's dead-URL was this).

### Tooling for the agent (CLI subcommands)

- [x] **C1. `money replay-capture <id|latest>`** — POST a quarantined capture
  back at `/capture` with optional `--as-login` override. (Done: commit aec91aa.)
- [x] **C2. `money capture {list,inspect}`** — `list [--unresolved]` shows
  recent captures with size + institution + timestamp; `inspect <id>`
  pretty-prints JSON structure / extracts a field. (Done: commit 3ac9acc.)
- [ ] **C3. `money config {get,set,edit}`** — atomic read-modify-write of
  `/app/.data/config.json` with schema validation, `--dry-run` diff.
- [ ] **C4. `money registry probe`** — print `_discover()` results + per-
  institution signatures, so module-load failures are visible without
  inline imports.
- [ ] **C5. `money parse-test <inst> <capture>`** — run an institution's
  parser against a capture without DB writes. Closes the inner debug loop.
- [x] **C6. `infra/scripts/m` wrapper** — `kubectl exec -n homelab
  deploy/ingest -- money "$@"` so the agent runs `m replay-capture latest`
  instead of building SSH heredocs. Update CLAUDE.md to point here. (Done: commit 1a5ce96.)

## Tier 2 — medium leverage

- [ ] **D1. Collapse the three capture handlers** (`_handle_capture`,
  `_handle_cookies`, `_handle_network_log` at [server.py:1866 / 1961 /
  2090][srv-handlers]) into one shared pipeline. `_handle_cookies` doesn't
  guard `login_id is None` (writes to `cookies/None.json`);
  `_handle_network_log` triggers auto-sync without cookies (silently fails
  for institutions that need them).
- [ ] **D2. Real `Protocol` for the institution plugin contract.**
  `InstitutionInfo.sync_fn` is `Callable[..., None]` because actual
  signatures aren't compatible; `_extract_identity` does three different
  things across three institutions. A typed `Protocol` would make the next
  institution a known-friction task instead of a runtime TypeError.
- [ ] **D3. Vitest harness for the extension** with a `chrome.*` shim. Test
  `handleNavigation` cooldown + re-entry guard (the bug we fixed today).
  Test `getInstitutionForUrl`, `findCapturedToken`. Half-day; permanent ROI.
- [ ] **D4. Provenance.** Every row in `transactions/balances/holdings` should
  reference an `ingestion_log` FK, not a free-form nullable `raw_file_ref`
  string. Add a checksum + parser version on `ingestion_log`.
- [ ] **D5. Server-side surfacing of extension capture errors.** Extension's
  `postToServer` errors die in a 20-entry `chrome.storage` ring buffer.
  Forward them to a `/extension/error` endpoint + monitor pane.
- [ ] **D6. Loud-fail the silent-swallows in `ally_api.py:402-440`,
  `betterment.py:489-505`, `wealthfront.py:368-383`.** Today a 401 on every
  account still produces an `IngestionStatus.SUCCESS` row.

## Tier 3 — bigger projects

- [ ] **M1. PocketBase migration.** [services/ingest/MIGRATION.md][migmd] is
  honest prose but a weak plan — needs a real divergence-resolution story
  for the dual-write phase, and a load-test acceptance threshold for the
  net-worth time-series queries. 2-3 weeks focused.
- [ ] **M2. Real schema migrations.** Today: `if column not in PRAGMA
  table_info` snippets at [db.py:38-216][db38]; `SCHEMA_VERSION = 1` frozen
  across ~10 schema changes; `schema.sql` and `db.py` constraints have
  drifted (the doubled-net-worth bug). Adopt alembic or write a versioned
  migration table that's actually checked.
- [ ] **M3. Network-log + cookie lifecycle.** `network_logs/` (50 files, 64
  MB), `unresolved_captures/` (13 files), and `cookies/` all grow without
  rotation. Add a TTL sweeper or move to PB with a retention policy.
- [ ] **M4. Replay-from-raw codepath.** `RawStore` is `put/get/exists` only —
  no `list/iter`. The raw archive is effectively WORM with no reader. Add
  enumeration + a `money replay-raw <login>` codepath that rebuilds the DB
  from the on-disk raw store.

## Workflow notes for future Claude

- Memory entry `feedback_no_inline_python` says no one-off `python -c`
  chains. I ignored it all morning. Until C1–C6 land, when I need an
  inline operation: **write a script under `services/ingest/scripts/`**
  and run that, don't pipe heredocs through ssh.
- Next-touch heuristic: if I find myself needing the same `kubectl exec ...
  python -c '...'` shape twice in a session, add it as a `money` subcommand
  before doing it the third time.

[ti47]: services/ingest/tests/test_identity.py#L47
[srv1829]: services/ingest/src/money/server.py#L1829-L1832
[srv-handlers]: services/ingest/src/money/server.py#L1866
[migmd]: services/ingest/MIGRATION.md
[db38]: services/ingest/src/money/db.py#L38-L216
