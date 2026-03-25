// Chase handler — records network log (API can't be replayed with cookies).

export default {
  domains: [".chase.com", "secure.chase.com", "secure03b.chase.com"],
  authPattern: /secure\d*\w?\.chase\.com/,
  recordNetwork: true,

  async onPageLoad(ctx) {
    // Chase needs network recording, not cookie capture.
    // Start recording and let the periodic flush handle sending data.
    await ctx.startNetworkRecording();
    return { type: "recording_started" };
  },
};
