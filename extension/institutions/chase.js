// Chase handler — records network log (API can't be replayed with cookies).
// Waits for the user to browse the dashboard, then flushes captured data.

export default {
  domains: [".chase.com", "secure.chase.com", "secure03b.chase.com"],
  authPattern: /secure\d*\w?\.chase\.com/,
  recordNetwork: true,

  async onPageLoad(ctx) {
    await ctx.startNetworkRecording();

    // Wait for the SPA to make its API calls
    await new Promise(resolve => setTimeout(resolve, 10000));

    const flushResult = await ctx.flushNetworkLog();
    if (flushResult.sync_id) {
      const syncResult = await ctx.pollSyncResult(flushResult.sync_id);
      return { type: "sync", ...syncResult };
    }
    return flushResult;
  },
};
