// Wealthfront handler — captures cookies on authenticated pages.

export default {
  domains: [".wealthfront.com", "www.wealthfront.com"],
  authPattern: /www\.wealthfront\.com\/(overview|dashboard|portfolio|transfers)/,

  async onPageLoad(ctx) {
    const cookieResult = await ctx.captureCookies();
    if (cookieResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(cookieResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return cookieResult;
  },
};
