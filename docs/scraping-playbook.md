# Scraping & Sync Playbook

## Architecture Overview

Data collection uses two paths depending on institution:

1. **Cookie relay** (Betterment, Wealthfront, Capital One, Fidelity): Extension captures browser cookies and sends to server. Server replays cookies to make API calls directly.
2. **Network log capture** (Chase, Morgan Stanley): Extension records API responses from the browser. Server parses captured responses. No API replay.
3. **Playwright login** (Ally): Extension triggers server-side headless browser login. Server captures auth token during login and makes API calls immediately.

```
Chrome Extension                    Server (port 5555)
  |                                     |
  |-- POST /cookies ------>  save + sync (cookie-based)
  |-- POST /network-log --->  save + sync (network-log-based)
  |-- POST /trigger-sync --->  playwright login + sync (Ally)
```

## General Debugging

### Server not receiving data from extension

1. Check server is running: `curl http://localhost:5555/health`
2. Server must bind `0.0.0.0` (WSL2): `money serve --host 0.0.0.0`
3. Extension popup should show green health dot
4. Check service worker console: chrome://extensions → Money Data Collector → "Inspect views: service worker"

### Extension doesn't trigger on page load

- Each handler has an `authPattern` regex that must match the URL
- There's a 30-second cooldown between captures for the same institution
- Cooldown only applies on **success** — failed attempts allow retry
- Check `activeHandlers` set — a handler already running blocks new ones

### Sync starts but fails

- Check server terminal output for tracebacks
- Raw data saved to `.data/raw/{institution}/{login_id}/`
- Network logs saved to `.data/network_logs/{institution}_{timestamp}.json`
- Cookies saved to `.data/cookies/{login_id}.json`

### Verify sync worked

```bash
# Check sync status
curl http://localhost:5555/api/sync-status | python -m json.tool

# Check specific institution's last sync
curl "http://localhost:5555/api/last-sync?institution=ally"

# Check account data
curl http://localhost:5555/api/accounts | python -m json.tool
```

---

## Per-Institution Playbook

### Ally Bank

**Auth:** Playwright (headless browser login)
**Trigger:** Extension detects `secure.ally.com` → POST `/trigger-sync` → server runs Playwright

**How it works:**
1. Extension sees you visit Ally → sends `/trigger-sync` to server
2. Server spawns `_run_playwright_sync()` in background thread
3. Playwright opens headless Chrome, fills username/password from 1Password
4. Intercepts auth token from login response (`data.data.json_data.access_token`)
5. Uses token + session cookies to call Ally's REST API directly

**Endpoints hit:**
- `/acs/v3/customers/self` — customer info, find customer ID
- `/acs/v1/customer-transfers/transfer-accounts?customerId={id}` — accounts list
- `/acs/v1/bank-accounts/transactions/search` — transactions (POST, paginated)
- `/acs/v1/bank-accounts/{acctId}` — account details

**Incremental sync:** Stops paginating transactions 14 days before the last known transaction date.

**When it breaks:**
- **MFA challenge:** Playwright waits up to 120s. If headless, you can't respond. Run `money login ally --login scott` without `--headless` to complete MFA interactively.
- **Login form changed:** Check screenshots at `.data/debug/ally_*.png`. Update selectors in `src/money/ingest/scrapers/ally.py`.
- **Token not captured:** The response interceptor looks for `access_token` in a deeply nested path. Log the responses to verify format.
- **401 on API calls:** Token is session-bound. Must be used immediately after capture. Cannot be replayed later.

**Manual CLI sync:**
```bash
money sync ally --login scott
money sync ally --login angela
```

---

### Betterment

**Auth:** Cookie relay
**Trigger:** Extension detects `wwws.betterment.com/(app|investing|summary|goals)` → captures cookies → POST `/cookies`

**How it works:**
1. Extension captures all `.betterment.com` cookies
2. Server fetches CSRF token from `GET /app` HTML page (`<meta name="csrf-token">`)
3. Makes GraphQL queries using cookies + CSRF token

**GraphQL queries:**
- `SidebarAccounts` — envelopes, purposes, accounts
- `PurposeHeader` — envelope balance, legal sub-accounts
- `EnvelopeAccountPerformanceHistory` — daily performance time series
- `EnvelopeAccountHoldings` — security positions per account

**When it breaks:**
- **CSRF fetch hangs:** Added 30-second timeout. If it hangs, cookies are probably expired. Revisit Betterment in Chrome.
- **GraphQL 401:** Session expired. Revisit the site to refresh cookies.
- **Duplicate account names:** `_build_display_name()` handles this by combining purpose + account name.
- **No performance data:** Only `ManagedAccount` type has performance history. Cash/Checking accounts don't.

**Account types:** Maps GraphQL `__typename` to AccountType. Name keywords override (e.g., "IRA" in name → IRA type).

**Amounts in cents:** All Betterment monetary values are in cents. Divide by 100.

---

### Wealthfront

**Auth:** Cookie relay
**Trigger:** Extension detects `www.wealthfront.com/(overview|dashboard|portfolio|transfers)` → captures cookies

**How it works:**
1. Server replays cookies with generated UUID headers (`wf-session-id`, `wf-request-id`, `wf-guest-id`)
2. CSRF token extracted from `xsrf` cookie value (URL-decoded)
3. Multiple REST endpoints hit per account

**Endpoints:**
- `/capitan/v1/accounts/overviews2` — account list with balances
- `/capitan/v1/accounts/{id}/performance?period_range_identifier=ALL` — daily performance
- `/capitan/v1/accounts/{id}/taxable-open-lots` — holdings (aggregated by symbol)
- `/api/transactions/{numericId}/transfers-for-account` — transfers as transactions

**When it breaks:**
- **Transfers endpoint returns error JSON:** Caught by `ValidationError` handler, skipped gracefully. Not blocking.
- **Numeric ID mapping fails:** The dashboard/transfers endpoints need a separate numeric ID. If the mapping call fails, those endpoints are skipped.
- **Holdings aggregation:** Tax lots aggregated by symbol. Cost basis summed across lots.

**Account filtering:** Only `FUNDED` and `OPENED` accounts are synced.

---

### Capital One

**Auth:** Cookie relay
**Trigger:** Extension detects `myaccounts.capitalone.com/(accountSummary|accountDetail)` → captures cookies

**How it works:**
1. Server fetches accounts list
2. For each account, fetches transactions in 90-day chunks going back up to 730 days
3. Account reference IDs are **double URL-encoded** (`%252F`)

**Endpoints:**
- `/web-api/protected/1350813/credit-cards/card-customers/accounts` — accounts
- `/web-api/protected/19902/credit-cards/accounts/{encodedRef}/transactions?fromDate=...&toDate=...` — transactions

**When it breaks:**
- **400 on transactions:** Date range too wide. Chunked to 90 days max.
- **Double encoding wrong:** The `accountReferenceId` contains `/` which must be encoded as `%2F`, then the whole thing encoded again so `%2F` becomes `%252F`.
- **Incremental sync:** Uses 7-day overlap from last known transaction.

**Only credit cards.** No checking/savings at Capital One.

---

### Chase

**Auth:** Network log capture (no API replay possible)
**Trigger:** Extension detects `secure.chase.com` → starts network recording → waits 10s → flushes

**How it works:**
1. Extension records all fetch/XHR requests on the page
2. After 10 seconds, sends captured entries to server
3. Server parses response bodies by URL pattern — no API calls made

**URL patterns matched in network log:**
- `account/detail/dda/list` → DDA account details (balance, nickname, mask)
- `etu-dda-transactions` → transaction list with running balance
- `rewards` + `summary` → credit card rewards/info
- `dashboard/module` → cached activity options (account list)

**When it breaks:**
- **No transactions matched:** Transactions are matched to accounts by comparing `runningLedgerBalanceAmount` to `presentBalance`. If balances don't match within $0.01, transactions are orphaned.
- **Missing dashboard cache:** Account list comes from dashboard module cache. If not captured, accounts are incomplete.
- **Only 10s of recording:** The SPA may not have finished loading. Increase wait time in `extension/institutions/chase.js` if needed.

**Cannot replay cookies.** Chase uses TLS fingerprinting. Any attempt to use captured cookies from Python's `urllib` returns 401.

---

### Morgan Stanley (Shareworks)

**Auth:** Network log capture (JWT extraction)
**Trigger:** Extension detects `shareworks.solium.com` → records network → waits 10s → flushes

**How it works:**
1. Extension captures network traffic including request headers
2. Server extracts Bearer JWT and session UUID from captured request headers
3. Server makes API calls using extracted credentials

**Endpoints (called by server, not just captured):**
- `/rest/participant/v2/portfolio/summary` — portfolio with per-award vested/unvested values + FMV
- `/rest/participant/v2/grants` — grant details with vesting dates

**When it breaks:**
- **No Bearer token in headers:** The page interceptor captures request headers, but only for headers explicitly set by JavaScript. If the SPA doesn't set `Authorization` explicitly, it won't appear. Check the network log entries for `/rest/participant/v2/` URLs.
- **Strike price parsing:** Extracted from grant name string (e.g., `"02/05/2024 - ISO - $12.98"`). Logs a warning if no `$` found.
- **Vested values mismatch:** Uses `availableQuantity`/`availableValue` from portfolio summary, not estimated from schedule.

**FMV (409A valuation):** Stored in `private_valuations` table. Used for equity value calculations in net worth chart.

**Which page to visit:** Navigate to the Portfolio or Grants page on Shareworks. The extension will capture the API responses.

---

### Fidelity NetBenefits

**Auth:** Cookie relay
**Trigger:** Extension detects `workplaceservices.fidelity.com/mybenefits/navstation`

**How it works:**
1. Server makes a single API call to the plan summary endpoint
2. Returns monthly performance data (balance + return %) 

**Single endpoint:**
```
/mybenefits/dcsummary/api/relationships/employer=000789812;plan=5504W/planSummary
```

Note: Employer ID and Plan ID are **hardcoded**. Must be updated if employer changes.

**When it breaks:**
- **HTML returned instead of JSON:** Cookies expired. Most common failure. Revisit Fidelity in Chrome.
- **Akamai blocks request:** Fidelity has aggressive bot protection. Only this one endpoint works with cookie relay. Other endpoints (holdings, transactions) are blocked.
- **Wrong employer/plan ID:** Capture the correct IDs from the network tab when logging in. Update in the sync function.

**Monthly granularity only.** No daily data, no holdings breakdown, no individual transactions.

---

## Extension Architecture

The extension uses a handler-per-institution pattern:

```
extension/
  background.js          # Router: URL → handler dispatch
  institutions/
    ally.js              # Triggers Playwright sync
    betterment.js        # Cookie capture
    wealthfront.js       # Cookie capture
    capital_one.js       # Cookie capture
    chase.js             # Network recording (10s)
    morgan_stanley.js    # Network recording (10s)
  content/
    network_recorder.js  # Injects page_interceptor.js
    page_interceptor.js  # Patches fetch/XHR to capture responses
```

**Adding a new institution:**
1. Create `extension/institutions/{name}.js` with `domains`, `authPattern`, and `onPageLoad(ctx)`
2. Import and register in `background.js` HANDLERS object
3. Add `host_permissions` and `content_scripts` matches in `manifest.json`

**Handler context (`ctx`) provides:**
- `captureCookies()` — capture and send cookies to server
- `startNetworkRecording()` — begin recording fetch/XHR
- `flushNetworkLog()` — send buffered entries to server
- `executeInPage(fn, args)` — inject script into page context
- `triggerSync()` — POST `/trigger-sync` to server
- `getLastSync()` — query last sync date for incremental fetching
- `pollSyncResult(syncId)` — wait for background sync to complete

**Capture filter:** Handlers can set `captureFilter: /regex/` to only buffer matching URLs (reduces noise from analytics/tracking).
