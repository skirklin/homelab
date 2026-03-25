// Wealthfront handler — captures cookies on authenticated pages.

export default {
  domains: [".wealthfront.com", "www.wealthfront.com"],
  authPattern: /www\.wealthfront\.com\/(overview|dashboard|portfolio|transfers)/,

  async onPageLoad(ctx) {
    return await ctx.captureCookies();
  },
};
