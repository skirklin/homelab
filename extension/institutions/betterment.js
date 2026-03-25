// Betterment handler — captures cookies on authenticated pages.

export default {
  domains: [".betterment.com", "wwws.betterment.com"],
  authPattern: /wwws\.betterment\.com\/(app|investing|summary|goals)/,

  async onPageLoad(ctx) {
    return await ctx.captureCookies();
  },
};
