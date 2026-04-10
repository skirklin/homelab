export default {
  domains: [".wealthfront.com", "www.wealthfront.com"],
  authPattern: /www\.wealthfront\.com\/(overview|dashboard|portfolio|transfers)/,

  async onPageLoad(ctx) {
    await ctx.startRecording();
    await ctx.wait(10000);

    // Actively fetch the user's email using a synchronous XHR from the page context.
    // This uses the page's session cookies automatically.
    const email = await ctx.scrapeText(() => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/api/users/current-user", false); // synchronous
        xhr.send();
        if (xhr.status === 200) {
          return JSON.parse(xhr.responseText).email || null;
        }
      } catch {}
      return null;
    });
    if (email) ctx.setUserIdentity(email);

    const result = await ctx.capture();
    if (result.sync_id) return await ctx.pollSyncResult(result.sync_id);
    return result;
  },
};
