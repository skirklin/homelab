/**
 * event-watcher — streams k8s Events into the api's /data/pod_events endpoint.
 *
 * k8s only retains Events for ~1 hour by default; this captures them for
 * long-term history. Runs as a Deployment in the cluster with RBAC scoped to
 * read events cluster-wide.
 *
 * Env:
 *   API_URL              (default: http://functions.homelab.svc.cluster.local:3000)
 *   API_TOKEN            (required: hlk_-prefixed admin api token)
 *   EVENT_KINDS          (default: "Pod" — comma-separated involved-object kinds to forward)
 *   IGNORE_REASONS       (default: empty — comma-separated reasons to drop, e.g. noisy normals)
 *
 *   --- Self-reporting alert path. The watcher is silent by default when it can't
 *   write events (e.g. token lacks `infra` role → 403). These knobs make it
 *   page the operator over Web Push when a failure streak crosses a threshold.
 *
 *   ALERT_USER_ID        (optional: PB user id to send alerts to. If unset, alerting
 *                         is disabled and we just log. The watcher's own API_TOKEN
 *                         is reused as the bearer for /push/send — that endpoint
 *                         requires isApiKey + an explicit userId param, so we need
 *                         to know who to wake up. Stamp this with the operator's
 *                         user id at deploy time.)
 *   ALERT_AFTER_FAILURES (default 10. Threshold of consecutive non-2xx responses
 *                         before the first alert fires.)
 *   ALERT_COOLDOWN_MS    (default 3600000 = 1h. Minimum gap between alerts so a
 *                         long-running outage doesn't fire one push per event.)
 *   ALERT_ON_RECOVERY    (default false. If "true", also send a push when the
 *                         POST starts succeeding again after a failure streak.)
 */

import * as k8s from "@kubernetes/client-node";

const API_URL = process.env.API_URL || "http://functions.homelab.svc.cluster.local:3000";
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error("API_TOKEN env var is required");
  process.exit(1);
}

const KINDS = (process.env.EVENT_KINDS || "Pod").split(",").map((s) => s.trim()).filter(Boolean);
const IGNORE_REASONS = new Set(
  (process.env.IGNORE_REASONS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

// --- Alerting config -------------------------------------------------------

const ALERT_USER_ID = process.env.ALERT_USER_ID || "";
const ALERT_AFTER_FAILURES = (() => {
  const raw = process.env.ALERT_AFTER_FAILURES;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
const ALERT_COOLDOWN_MS = (() => {
  const raw = process.env.ALERT_COOLDOWN_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 3_600_000;
})();
const ALERT_ON_RECOVERY = (process.env.ALERT_ON_RECOVERY || "").toLowerCase() === "true";

// Module-level alert state. Restarts reset the counter — fine; the operator's
// alerting tolerates a few extra failures across a pod restart, and not
// persisting this means we never carry stale state across deploys.
let consecutiveFailures = 0;
let lastAlertSentAt = 0;

async function sendAlertPush(title: string, body: string): Promise<void> {
  if (!ALERT_USER_ID) {
    // Alerting disabled by config. Log loud enough that whoever's grepping
    // the logs after the fact sees we tried.
    console.error(`[alert] ALERT_USER_ID unset — would have sent: ${title} | ${body}`);
    return;
  }
  try {
    const res = await fetch(`${API_URL}/push/send`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: ALERT_USER_ID,
        title,
        body,
        url: "https://monitor.tail56ca88.ts.net/",
        data: { source: "event-watcher" },
      }),
    });
    if (!res.ok) {
      // Don't recurse into the alert path on alert-path failure; just log.
      // The push endpoint failing is itself bad but not the watcher's job
      // to escalate.
      console.error(`[alert] /push/send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      console.error(`[alert] sent push: ${title}`);
    }
  } catch (err) {
    console.error("[alert] /push/send error:", err instanceof Error ? err.message : err);
  }
}

async function maybeAlertOnFailure(status: number, responseBody: string): Promise<void> {
  if (consecutiveFailures < ALERT_AFTER_FAILURES) return;
  const now = Date.now();
  // First fire (lastAlertSentAt = 0) and any re-fire after the cooldown.
  if (lastAlertSentAt !== 0 && now - lastAlertSentAt < ALERT_COOLDOWN_MS) return;
  lastAlertSentAt = now;
  await sendAlertPush(
    `event-watcher: ${consecutiveFailures} consecutive POST failures`,
    `${status}: ${responseBody.slice(0, 80)}`,
  );
}

async function maybeAlertOnRecovery(previousFailures: number): Promise<void> {
  console.error(`event-watcher: back online (recovered after ${previousFailures} failures)`);
  if (!ALERT_ON_RECOVERY) return;
  await sendAlertPush(
    "event-watcher: back online",
    `Recovered after ${previousFailures} consecutive POST failures.`,
  );
}

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

type CoreEvent = {
  metadata?: { uid?: string; namespace?: string };
  involvedObject?: { kind?: string; name?: string };
  type?: string;
  reason?: string;
  message?: string;
  source?: { component?: string };
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
};

async function postEvent(ev: CoreEvent): Promise<void> {
  const uid = ev.metadata?.uid;
  if (!uid) return;
  const kind = ev.involvedObject?.kind;
  if (kind && KINDS.length > 0 && !KINDS.includes(kind)) return;
  const reason = ev.reason ?? "";
  if (IGNORE_REASONS.has(reason)) return;

  const type = ev.type === "Warning" ? "Warning" : "Normal";
  const lastSeen = ev.lastTimestamp || ev.eventTime || new Date().toISOString();
  const firstSeen = ev.firstTimestamp || lastSeen;

  const body = {
    uid,
    namespace: ev.metadata?.namespace ?? "",
    involved_kind: kind ?? "",
    involved_name: ev.involvedObject?.name ?? "",
    type,
    reason,
    message: ev.message ?? "",
    source: ev.source?.component ?? "",
    count: ev.count ?? 1,
    first_seen: firstSeen,
    last_seen: lastSeen,
  };

  try {
    const res = await fetch(`${API_URL}/data/pod_events`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`POST failed ${res.status}: ${text}`);
      consecutiveFailures += 1;
      // Alerting is best-effort and must not break the watch loop.
      await maybeAlertOnFailure(res.status, text).catch((err) => {
        console.error("[alert] maybeAlertOnFailure threw:", err instanceof Error ? err.message : err);
      });
    } else {
      if (consecutiveFailures > 0) {
        const recovered = consecutiveFailures;
        consecutiveFailures = 0;
        lastAlertSentAt = 0;
        await maybeAlertOnRecovery(recovered).catch((err) => {
          console.error("[alert] maybeAlertOnRecovery threw:", err instanceof Error ? err.message : err);
        });
      }
    }
  } catch (err) {
    // Network-level failure (DNS, connection refused, etc.) — count it the
    // same as a non-2xx so a black-holed api service still pages us.
    console.error("POST error:", err instanceof Error ? err.message : err);
    consecutiveFailures += 1;
    await maybeAlertOnFailure(0, err instanceof Error ? err.message : String(err)).catch((alertErr) => {
      console.error("[alert] maybeAlertOnFailure threw:", alertErr instanceof Error ? alertErr.message : alertErr);
    });
  }
}

// One pass = set up the watch, wait until it ends, return so the outer
// loop can reconnect. The k8s client's Watch.watch resolves once the
// stream is established, so we wrap it in an explicit promise that
// only settles when the done callback fires.
function watchOnce(): Promise<void> {
  const watcher = new k8s.Watch(kc);
  return new Promise<void>((resolve, reject) => {
    watcher.watch(
      "/api/v1/events",
      {},
      (_phase: string, ev: CoreEvent) => {
        postEvent(ev).catch((err) => console.error("postEvent rejected:", err));
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    ).catch(reject);
  });
}

async function watchLoop(): Promise<never> {
  while (true) {
    try {
      console.error("watch: connecting...");
      await watchOnce();
      console.error("watch: stream closed (clean), reconnecting in 2s");
    } catch (err) {
      console.error("watch: error,", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.error(
  `event-watcher starting → ${API_URL}, kinds=[${KINDS.join(",")}], ` +
  `alert_after=${ALERT_AFTER_FAILURES}, cooldown_ms=${ALERT_COOLDOWN_MS}, ` +
  `alert_on_recovery=${ALERT_ON_RECOVERY}, alert_user=${ALERT_USER_ID ? "set" : "unset"}`,
);
watchLoop().catch((err) => {
  console.error("watchLoop crashed:", err);
  process.exit(1);
});
