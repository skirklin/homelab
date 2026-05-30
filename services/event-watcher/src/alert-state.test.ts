import { describe, it, expect } from "vitest";
import { shouldAlert } from "./alert-state";

const config = {
  alertAfterFailures: 10,
  alertAfterMs: 600_000, // 10m
  cooldownMs: 3_600_000, // 1h
};

const T0 = 1_700_000_000_000;

describe("shouldAlert", () => {
  it("stays silent for a deploy blip: high count but short duration", () => {
    // 30 failures in 90s — count met, but the streak is far younger than the
    // 10m duration gate. This is the deploy-blip case the operator wants quiet.
    expect(
      shouldAlert(
        { consecutiveFailures: 30, failingSince: T0, lastAlertSentAt: 0, now: T0 + 90_000 },
        config,
      ),
    ).toBe(false);
  });

  it("pages a sustained outage: count met, duration met, no prior alert", () => {
    expect(
      shouldAlert(
        { consecutiveFailures: 12, failingSince: T0, lastAlertSentAt: 0, now: T0 + 700_000 },
        config,
      ),
    ).toBe(true);
  });

  it("stays silent below the failure floor even if the duration is met", () => {
    expect(
      shouldAlert(
        { consecutiveFailures: 3, failingSince: T0, lastAlertSentAt: 0, now: T0 + 700_000 },
        config,
      ),
    ).toBe(false);
  });

  it("suppresses a re-fire within the cooldown window", () => {
    expect(
      shouldAlert(
        // count + duration both met, but we paged 10m ago (< 1h cooldown).
        { consecutiveFailures: 50, failingSince: T0, lastAlertSentAt: T0 + 600_000, now: T0 + 1_200_000 },
        config,
      ),
    ).toBe(false);
  });

  it("re-fires once the cooldown has elapsed", () => {
    expect(
      shouldAlert(
        { consecutiveFailures: 50, failingSince: T0, lastAlertSentAt: T0, now: T0 + 3_700_000 },
        config,
      ),
    ).toBe(true);
  });

  it("never fires when healthy (failingSince = 0)", () => {
    expect(
      shouldAlert(
        { consecutiveFailures: 0, failingSince: 0, lastAlertSentAt: 0, now: T0 },
        config,
      ),
    ).toBe(false);
  });
});
