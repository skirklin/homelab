export default {
  domains: [".solium.com", "shareworks.solium.com", ".morganstanley.com"],
  authPattern: /shareworks\.solium\.com/,

  async onPageLoad(ctx) {
    await ctx.startRecording();

    // Wait for any authenticated API call (contains Bearer JWT)
    await ctx.waitForEntries([/solium\.com.*api/i], { timeout: 30000 });

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
