# Money Data Collector — Chrome Extension

Captures financial data from bank websites and sends it to the local Money server for ingestion.

## How it works

Each institution has a handler in `institutions/` that defines:
- **domains** — URL patterns to match (e.g. `secure.ally.com`)
- **authPattern** — regex for authenticated pages (skips login/public pages)
- **onPageLoad(ctx)** — what to do when the user visits the site

The background service worker (`background.js`) is a router:
1. `webNavigation.onCompleted` fires when a page loads
2. URL is matched to a handler via its `domains`
3. `authPattern` filters to only authenticated pages
4. Handler's `onPageLoad(ctx)` is called with a context object

## Handler context (ctx)

The context provides tools for data capture:

| Method | Description |
|---|---|
| `captureCookies()` | Read all cookies for the institution's domains, send to server |
| `startNetworkRecording()` | Inject the page interceptor to capture fetch/XHR responses |
| `executeInPage(fn, args)` | Inject a function into the page's JS context (has page's session) |
| `findCapturedToken()` | Search buffered network entries for an auth token |
| `flushNetworkLog()` | Send all buffered network entries to server |
| `getLastSync()` | Ask server for the date of last known data |

## Institution capture strategies

| Institution | Strategy | How it works |
|---|---|---|
| Betterment | Cookie capture | Extension sends cookies → server replays GraphQL API |
| Wealthfront | Cookie capture | Extension sends cookies → server replays REST API |
| Capital One | Cookie capture | Extension sends cookies → server replays REST API |
| Chase | Network recording | Extension records API responses → server parses them |
| Morgan Stanley | Network recording | Extension records API responses → server extracts JWT + calls API |
| Ally | Hybrid | Extension records login token + injects transaction fetches → server parses responses |

## Files

```
extension/
├── background.js              # Router + handler context + message handling
├── manifest.json              # Chrome MV3 manifest (ES module service worker)
├── popup.html / popup.js      # Manual controls (cookie capture, recording)
├── institutions/              # Per-institution handlers
│   ├── ally.js
│   ├── betterment.js
│   ├── capital_one.js
│   ├── chase.js
│   ├── morgan_stanley.js
│   └── wealthfront.js
└── content/
    ├── network_recorder.js    # Content script — injects page interceptor
    └── page_interceptor.js    # Runs in page context — patches fetch/XHR
```

## Adding a new institution

1. Create `institutions/{name}.js`:
```javascript
export default {
  domains: [".example.com"],
  authPattern: /app\.example\.com/,
  async onPageLoad(ctx) {
    return await ctx.captureCookies();
  },
};
```

2. Import and add to `HANDLERS` in `background.js`
3. Add domain permissions to `manifest.json` (`host_permissions` and `content_scripts.matches`)

## Server endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/cookies` | POST | Receive captured cookies, trigger auto-sync |
| `/network-log` | POST | Receive captured network entries, trigger auto-sync |
| `/api/last-sync?institution=X` | GET | Last known data date for incremental sync |
