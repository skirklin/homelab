// Ally Bank handler — captures auth token from login, then fetches data
// from within the page using that token + the browser's session cookies.

export default {
  domains: [".ally.com", "secure.ally.com"],
  authPattern: /secure\.ally\.com/,
  recordNetwork: true,
  captureFilter: /secure\.ally\.com\/acs\//,

  async onPageLoad(ctx) {
    // Start recording so we capture the SPA's own API calls (including login response)
    await ctx.startNetworkRecording();

    // Wait for the SPA to finish loading and making its initial API calls
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Look for the auth token in what we've captured so far
    const token = ctx.findCapturedToken();
    if (!token) {
      console.warn("[Money] No Ally auth token found in captured responses");
      return await ctx.flushNetworkLog();
    }

    console.log("[Money] Found Ally auth token, fetching transaction data...");

    // Ask the server how far back we need to go
    const syncInfo = await ctx.getLastSync();
    const lastTxnDate = syncInfo?.last_transaction || null;

    // Inject a script that fetches transactions using the captured token
    await ctx.executeInPage(allyFetchTransactions, { token, lastTxnDate });

    // Poll until the script signals completion (or timeout after 2 minutes)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ctx.tabId },
        func: () => window.__moneyAllyDone,
        world: "MAIN",
      });
      if (result?.result) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const flushResult = await ctx.flushNetworkLog();
    if (flushResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(flushResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return flushResult;
  },
};

// Runs in the PAGE context. Uses the token explicitly in the Authorization
// header, and the browser automatically attaches its session cookies.
function allyFetchTransactions(args) {
  const { token, lastTxnDate } = args;
  window.__moneyAllyDone = false;

  (async () => {
    try {
      console.log("[Money] Fetching Ally transactions...",
        lastTxnDate ? `(since ${lastTxnDate})` : "(full)");

      // Get accounts (the SPA already fetched these, but we need the IDs)
      const customerResp = await window.fetch("/acs/v3/customers/self", {
        headers: { "Authorization": `Bearer ${token}` },
      });
      const customer = await customerResp.json();
      let customerId = null;
      for (const rel of (customer.data?.lobRelationships || [])) {
        if (rel.lob === "ACM") { customerId = rel.id; break; }
      }
      if (!customerId) customerId = customer.data?.id;
      if (!customerId) { console.error("[Money] No customer ID"); return; }

      const accountsResp = await window.fetch(
        `/acs/v1/customer-transfers/transfer-accounts?customerId=${customerId}`, {
          headers: { "Authorization": `Bearer ${token}` },
        }
      );
      const accountsData = await accountsResp.json();
      const accounts = accountsData.accounts || accountsData.data || [];
      console.log("[Money] Found", accounts.length, "accounts");

      for (const acct of accounts) {
        const details = acct.domainDetails || {};
        if (details.externalAccountIndicator) continue;
        if ((acct.accountStatus || "").toUpperCase() !== "ACTIVE") continue;

        const acctId = details.accountId || acct.id;
        const last4 = (acct.accountNumberPvtEncrypt || "").slice(-4);
        console.log("[Money] Fetching transactions for ••" + last4);

        let requestBody = { accountNumberPvtEncrypt: acctId, recordsToPull: 100 };
        let totalTxns = 0;
        let page = 1;
        let reachedKnownData = false;

        while (page <= 50 && !reachedKnownData) {
          const txnResp = await window.fetch("/acs/v1/bank-accounts/transactions/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify(requestBody),
          });
          const txnData = await txnResp.json();

          let gotMore = false;
          for (const result of (txnData.searchResults || [])) {
            for (const history of (result.transactionHistory || [])) {
              if (history.transactionStatusType !== "POSTED") continue;
              const txns = history.transactions || [];
              totalTxns += txns.length;

              if (lastTxnDate && txns.length > 0) {
                const oldestInPage = txns[txns.length - 1].transactionPostingDate || "";
                if (oldestInPage.slice(0, 10) < lastTxnDate) {
                  console.log("[Money] Reached known data at", oldestInPage.slice(0, 10));
                  reachedKnownData = true;
                }
              }

              const nextPage = history.nextPageRequestDetails;
              if (nextPage && txns.length > 0 && !reachedKnownData) {
                requestBody = { ...nextPage, recordsToPull: 100 };
                gotMore = true;
                page++;
              }
            }
          }

          if (!gotMore) break;
          if (page % 5 === 0) {
            console.log("[Money] ••" + last4 + " page " + page + " (" + totalTxns + " txns)");
          }
        }

        console.log("[Money] ••" + last4 + ": " + totalTxns + " transactions");
      }

      console.log("[Money] Ally data fetch complete");
    } catch (err) {
      console.error("[Money] Ally fetch error:", err);
    } finally {
      window.__moneyAllyDone = true;
    }
  })();
}
