// Morgan Stanley handler — records network log for JWT extraction.

export default {
  domains: [".solium.com", "shareworks.solium.com", ".morganstanley.com"],
  authPattern: /shareworks\.solium\.com/,
  recordNetwork: true,

  async onPageLoad(ctx) {
    await ctx.startNetworkRecording();
    return { type: "recording_started" };
  },
};
