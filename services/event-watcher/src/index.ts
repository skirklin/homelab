/**
 * event-watcher — streams k8s Events into the api's /data/pod_events endpoint.
 *
 * k8s only retains Events for ~1 hour by default; this captures them for
 * long-term history. Runs as a Deployment in the cluster with RBAC scoped to
 * read events cluster-wide.
 *
 * Env:
 *   API_URL          (default: http://functions.homelab.svc.cluster.local:3000)
 *   API_TOKEN        (required: hlk_-prefixed admin api token)
 *   EVENT_KINDS      (default: "Pod" — comma-separated involved-object kinds to forward)
 *   IGNORE_REASONS   (default: empty — comma-separated reasons to drop, e.g. noisy normals)
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
      console.error(`POST failed ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("POST error:", err instanceof Error ? err.message : err);
  }
}

async function watch(): Promise<void> {
  const watcher = new k8s.Watch(kc);
  await watcher.watch(
    "/api/v1/events",
    {},
    (_phase: string, ev: CoreEvent) => {
      postEvent(ev).catch((err) => console.error("postEvent rejected:", err));
    },
    (err) => {
      // Server-side watch closed (timeout, network blip, etc.); reconnect.
      if (err) console.error("watch ended:", err instanceof Error ? err.message : err);
      setTimeout(() => {
        watch().catch((e) => console.error("watch restart failed:", e));
      }, 2000);
    },
  );
}

console.log(`event-watcher starting → ${API_URL}, kinds=[${KINDS.join(",")}]`);
watch().catch((err) => {
  console.error("watch start failed:", err);
  process.exit(1);
});
