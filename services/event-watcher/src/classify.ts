/**
 * Transient-vs-alertable response classification for the event-watcher's
 * POST to /data/pod_events.
 *
 * The watcher's alert exists for genuine, human-fixable write failures —
 * e.g. the token lacks the `infra` role (403) or is otherwise rejected.
 * Transient backend-unavailability (PB/api restarting during a deploy,
 * gateway errors, network blips) is expected and already covered by Gatus
 * uptime monitoring, so it must NOT count toward the failure streak and
 * must NOT page.
 *
 * The network-error path (fetch threw) is treated as status 0.
 */
export function isTransientStatus(status: number): boolean {
  // 0 = network-level failure (DNS, connection refused, timeout).
  // 502/503/504 = gateway/service-unavailable from the api in front of PB,
  // including the new 503 the auth middleware returns when PB is unreachable.
  return status === 0 || status === 502 || status === 503 || status === 504;
}
