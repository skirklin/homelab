export default {
  domains: [".chase.com", "secure.chase.com", "secure03b.chase.com"],
  authPattern: /secure\d*\w?\.chase\.com/,

  async onPageLoad(ctx) {
    await ctx.startRecording();

    // Wait for the DDA detail to arrive (signals authenticated page).
    await ctx.waitForEntries(["account/detail/dda/list"], { timeout: 30000 });

    // Actively force investment API calls from the page context. Chase caches
    // these aggressively, so we can't rely on natural page loads.
    await ctx.executeInPage(chaseFetchInvestments, {});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const done = await ctx.scrapeText(() => window.__moneyChaseDone);
      if (done) break;
      await ctx.wait(1000);
    }

    // Scrape the user's name from the page header
    const name = await ctx.scrapeText(() => {
      const greetingRe = /(?:Hi|Hello|Welcome|Good\s+(?:morning|afternoon|evening|night)),?\s+([A-Za-z][\w-]*)/i;
      for (const sel of [
        '[data-testid="greeting"]', '.greeting', '.welcome-name',
        '[class*="greeting"]', '[class*="customerName"]',
        '[data-testid="user-name"]', '.user-name',
      ]) {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (!text) continue;
        const m = text.match(greetingRe);
        if (m) return m[1];
        if (!/\b(?:Hi|Hello|Welcome|Good)\b/i.test(text)) return text;
      }
      return null;
    });
    if (name) ctx.setUserIdentity(name);

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};

function chaseFetchInvestments() {
  window.__moneyChaseDone = false;

  const commonHeaders = { "x-jpmc-csrf-token": "NONE" };
  const jsonHeaders = { ...commonHeaders, "content-type": "application/json" };
  const formHeaders = {
    ...commonHeaders,
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };

  function collectSelectors(node, out) {
    if (Array.isArray(node)) { node.forEach(n => collectSelectors(n, out)); return; }
    if (node && typeof node === "object") {
      // If this is an account entry tagged as INVESTMENT, grab its accountId.
      const isInvest = node.accountCategoryType === "INVESTMENT"
        || node.groupType === "INVESTMENT";
      if (isInvest && (typeof node.accountId === "string" || typeof node.accountId === "number")) {
        out.add(String(node.accountId));
      }
      for (const [k, v] of Object.entries(node)) {
        if (/selector[_-]?identifier|digitalAccountIdentifier/i.test(k)
            && (typeof v === "string" || typeof v === "number")) {
          out.add(String(v));
        }
        collectSelectors(v, out);
      }
    }
  }

  (async () => {
    const selectors = new Set();
    try {
      // Prime: POST options/list2 returns investment accounts with selectorIdentifiers
      const listResp = await window.fetch(
        "/svc/rr/accounts/secure/v2/portfolio/account/options/list2",
        { method: "POST", headers: formHeaders, body: "filterOption=ALL" },
      );
      if (listResp.ok) {
        const listData = await listResp.json();
        collectSelectors(listData, selectors);
      }
    } catch (err) {
      console.warn("[Money] Chase: options/list2 failed", err);
    }

    // Also try app/data/list as a secondary source in case options/list2
    // doesn't include every investment account.
    try {
      const appResp = await window.fetch(
        "/svc/rl/accounts/l4/v1/app/data/list",
        { method: "POST", headers: formHeaders, body: "" },
      );
      if (appResp.ok) {
        const appData = await appResp.json();
        collectSelectors(appData, selectors);
      }
    } catch (err) {
      console.warn("[Money] Chase: app/data/list failed", err);
    }

    if (selectors.size === 0) {
      console.warn("[Money] Chase: no investment selectors found");
      window.__moneyChaseDone = true;
      return;
    }

    console.log(`[Money] Chase: fetching investments for ${selectors.size} account(s)`);

    const today = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

    const fetches = [];
    for (const sel of selectors) {
      fetches.push(
        window.fetch(
          "/svc/wr/dwm/secure/gateway/investments/servicing/inquiry-maintenance/digital-investment-positions/v2/positions",
          {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({
              selectorIdentifier: sel,
              selectorCode: "ACCOUNT",
              intradayUpdateIndicator: true,
              topPositionsRequestedRecordCount: 5,
              accountStatusIndicator: true,
              moversRequestedRecordCount: 5,
            }),
          },
        ).catch(err => console.warn(`[Money] Chase positions ${sel} failed`, err)),
        window.fetch(
          `/svc/wr/dwm/secure/gateway/investments/servicing/inquiry-maintenance/digital-investment-portfolio/v2/balances/daily-balances?selector-identifier=${sel}&selector-code=ACCOUNT&balance-end-date=${today}&balance-start-date=${yearAgo}`,
          { headers: jsonHeaders },
        ).catch(err => console.warn(`[Money] Chase daily-balances ${sel} failed`, err)),
        window.fetch(
          `/svc/wr/dwm/secure/gateway/investments/servicing/inquiry-maintenance/digital-investment-portfolio/v2/balances/monthly-balances?selector-identifier=${sel}&selector-code=ACCOUNT`,
          { headers: jsonHeaders },
        ).catch(err => console.warn(`[Money] Chase monthly-balances ${sel} failed`, err)),
      );
    }

    try {
      await Promise.all(fetches);
    } catch (err) {
      console.error("[Money] Chase investment fetch error:", err);
    } finally {
      window.__moneyChaseDone = true;
    }
  })();
}
