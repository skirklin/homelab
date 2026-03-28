// Capital One handler — captures cookies on authenticated pages.

export default {
  domains: [".capitalone.com", "myaccounts.capitalone.com"],
  authPattern: /myaccounts\.capitalone\.com\/(accountSummary|accountDetail)/,

  async onPageLoad(ctx) {
    const cookieResult = await ctx.captureCookies();
    if (cookieResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(cookieResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return cookieResult;
  },
};
