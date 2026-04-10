export default {
  domains: [".chase.com", "secure.chase.com", "secure03b.chase.com"],
  authPattern: /secure\d*\w?\.chase\.com/,

  async onPageLoad(ctx) {
    await ctx.startRecording();

    // Wait for the key API routes the parser needs
    await ctx.waitForEntries(["account/detail/dda/list"], { timeout: 30000 });

    // Try to scrape the logged-in user's name from the page header
    const name = await ctx.scrapeText(() => {
      for (const sel of [
        '[data-testid="greeting"]', '.greeting', '.welcome-name',
        '[class*="greeting"]', '[class*="customerName"]',
        '[data-testid="user-name"]', '.user-name',
      ]) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) {
          const m = el.textContent.match(/(?:Hi|Hello|Welcome),?\s+(\w+)/i);
          if (m) return m[1];
          return el.textContent.trim();
        }
      }
      return null;
    });
    if (name) ctx.setUserIdentity(name);

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
