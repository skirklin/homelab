// Capital One handler — captures cookies on authenticated pages.

export default {
  domains: [".capitalone.com", "myaccounts.capitalone.com"],
  authPattern: /myaccounts\.capitalone\.com\/(accountSummary|accountDetail)/,

  async onPageLoad(ctx) {
    return await ctx.captureCookies();
  },
};
