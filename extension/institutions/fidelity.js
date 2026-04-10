export default {
  domains: [".fidelity.com", "nb.fidelity.com", "workplaceservices.fidelity.com"],
  authPattern: /workplaceservices\.fidelity\.com\/mybenefits\/navstation/,

  async onPageLoad(ctx) {
    await ctx.startRecording();
    await ctx.wait(10000);
    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
