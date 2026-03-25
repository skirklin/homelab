// Ally Bank handler — triggers server-side Playwright sync.
// Ally's API requires session-bound tokens that can't be captured by the
// extension, so we just notify the server to run `sync_ally_api` via Playwright.

export default {
  domains: [".ally.com", "secure.ally.com"],
  authPattern: /secure\.ally\.com/,

  async onPageLoad(ctx) {
    const result = await ctx.triggerSync();
    return result;
  },
};
