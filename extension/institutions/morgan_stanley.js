// Morgan Stanley handler — records network log for JWT extraction.
// Waits for the user to browse Shareworks, then flushes captured data.

export default {
  domains: [".solium.com", "shareworks.solium.com", ".morganstanley.com"],
  authPattern: /shareworks\.solium\.com/,
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
