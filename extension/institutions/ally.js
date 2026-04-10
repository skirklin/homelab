export default {
  domains: [".ally.com", "secure.ally.com"],
  authPattern: /secure\.ally\.com/,
  captureFilter: /secure\.ally\.com\/acs\//,

  async onPageLoad(ctx) {
    await ctx.startRecording();

    // Wait for the login response (contains auth token) and accounts data
    await ctx.waitForEntries(["auth/login", "customers/self"], { timeout: 30000 });

    // Look for the auth token in captured responses
    const token = ctx.findCapturedToken();
    if (!token) {
      console.warn("[Money] No Ally auth token found");
      const result = await ctx.capture();
      if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
      return result;
    }

    // Fetch transaction data using the captured token
    const syncInfo = await ctx.getLastSync();
    const lastTxnDate = syncInfo?.last_transaction || null;

    await ctx.executeInPage(allyFetchTransactions, { token, lastTxnDate });

    // Poll until the injected script finishes
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const done = await ctx.scrapeText(() => window.__moneyAllyDone);
      if (done) break;
      await ctx.wait(2000);
    }

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};

function allyFetchTransactions(args) {
  const { token, lastTxnDate } = args;
  window.__moneyAllyDone = false;

  (async () => {
    try {
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
        `/acs/v1/customer-transfers/transfer-accounts?customerId=${customerId}`,
        { headers: { "Authorization": `Bearer ${token}` } },
      );
      const accountsData = await accountsResp.json();
      const accounts = accountsData.accounts || accountsData.data || [];

      for (const acct of accounts) {
        const details = acct.domainDetails || {};
        if (details.externalAccountIndicator) continue;
        if ((acct.accountStatus || "").toUpperCase() !== "ACTIVE") continue;

        const acctId = details.accountId || acct.id;
        let requestBody = { accountNumberPvtEncrypt: acctId, recordsToPull: 100 };
        let totalTxns = 0;
        let page = 1;
        let reachedKnownData = false;

        while (page <= 50 && !reachedKnownData) {
          const txnResp = await window.fetch("/acs/v1/bank-accounts/transactions/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
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
                const oldest = txns[txns.length - 1].transactionPostingDate || "";
                if (oldest.slice(0, 10) < lastTxnDate) reachedKnownData = true;
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
        }
      }
    } catch (err) {
      console.error("[Money] Ally fetch error:", err);
    } finally {
      window.__moneyAllyDone = true;
    }
  })();
}
