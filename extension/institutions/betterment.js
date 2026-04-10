export default {
  domains: [".betterment.com", "wwws.betterment.com"],
  authPattern: /wwws\.betterment\.com\/(app|investing|summary|goals)/,

  async onPageLoad(ctx) {
    await ctx.startRecording();
    await ctx.wait(10000);

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
