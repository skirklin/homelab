/**
 * In-process scheduler for high-frequency notification triggers.
 * Life tracker runs every 5 minutes — too frequent for a k8s CronJob.
 */
import { runLifeTrackerSampling } from "./life";

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  // Life tracker: every 5 minutes
  intervalId = setInterval(async () => {
    try {
      const result = await runLifeTrackerSampling();
      if (result.sent > 0) {
        console.log(`[scheduler] Life tracker: ${result.sent} sent, ${result.skipped} skipped`);
      }
    } catch (err) {
      console.error("[scheduler] Life tracker error:", err);
    }
  }, 5 * 60 * 1000);

  // Run once on startup (short delay for server init)
  setTimeout(() => {
    runLifeTrackerSampling().catch(err =>
      console.error("[scheduler] Initial life tracker run failed:", err),
    );
  }, 10_000);

  console.log("[scheduler] Started (life tracker every 5min)");
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
