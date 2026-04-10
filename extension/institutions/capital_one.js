export default {
  domains: [".capitalone.com", "myaccounts.capitalone.com"],
  authPattern: /myaccounts\.capitalone\.com\/(accountSummary|accountDetail)/,

  async onPageLoad(ctx) {
    await ctx.startRecording();
    await ctx.wait(10000);
    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
