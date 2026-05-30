/**
 * Pure alert-decision logic for the event-watcher.
 *
 * The watcher pages the operator when its POST to /data/pod_events keeps
 * failing. The trigger is duration-based, NOT status-class-based: a failure
 * that recovers quickly (a deploy blip — PB/api restarting) stays silent,
 * while a failure that persists past ALERT_AFTER_MS (a real outage, or a
 * revoked/bad token that never recovers) pages.
 *
 * Keeping the decision pure means index.ts owns only three mutable numbers
 * and this function answers "should we fire now?" — testable without a
 * running cluster.
 */

export type AlertState = {
  /** Count of failures in the current continuous streak. */
  consecutiveFailures: number;
  /** ms epoch when the current failure streak began (0 when healthy). */
  failingSince: number;
  /** ms epoch of the last alert sent (0 = never / reset on recovery). */
  lastAlertSentAt: number;
  /** Current time, ms epoch. */
  now: number;
};

export type AlertConfig = {
  /** Fluke-floor: minimum consecutive failures before we'll page. */
  alertAfterFailures: number;
  /** Duration gate: streak must be continuous for at least this long. */
  alertAfterMs: number;
  /** Minimum gap between successive alerts. */
  cooldownMs: number;
};

/**
 * Fire only when ALL hold:
 *  - the streak is at least `alertAfterFailures` failures (fluke-floor), AND
 *  - the streak has been continuous for at least `alertAfterMs` (didn't
 *    recover quickly), AND
 *  - the cooldown is satisfied (first fire, or `cooldownMs` since the last).
 */
export function shouldAlert(state: AlertState, config: AlertConfig): boolean {
  if (state.consecutiveFailures < config.alertAfterFailures) return false;
  if (state.failingSince === 0) return false;
  if (state.now - state.failingSince < config.alertAfterMs) return false;
  if (state.lastAlertSentAt !== 0 && state.now - state.lastAlertSentAt < config.cooldownMs) {
    return false;
  }
  return true;
}
