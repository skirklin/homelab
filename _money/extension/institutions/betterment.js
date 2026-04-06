// Betterment handler — captures cookies on authenticated pages.

export default {
  domains: [".betterment.com", "wwws.betterment.com"],
  authPattern: /wwws\.betterment\.com\/(app|investing|summary|goals)/,

  async onPageLoad(ctx) {
    const cookieResult = await ctx.captureCookies();
    if (cookieResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(cookieResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return cookieResult;
  },
};
