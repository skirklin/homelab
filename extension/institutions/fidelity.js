// Fidelity NetBenefits handler — captures cookies on authenticated pages.
// Login starts at nb.fidelity.com, then redirects to workplaceservices.fidelity.com.
// Server replays the planSummary API using captured cookies.

export default {
  domains: [".fidelity.com", "nb.fidelity.com", "workplaceservices.fidelity.com"],
  authPattern: /workplaceservices\.fidelity\.com\/mybenefits\/navstation/,

  async onPageLoad(ctx) {
    const cookieResult = await ctx.captureCookies();
    if (cookieResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(cookieResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return cookieResult;
  },
};
