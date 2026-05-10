export type Deployment = {
  id: string;
  created: string;
  git_sha: string;
  git_branch: string;
  git_subject: string;
  apps: string[];
  duration_seconds: number;
  status: "success" | "failure" | "partial";
  deployer: string;
  host: string;
  notes: string;
  failed_apps: string[];
};

export type GatusConditionResult = { condition: string; success: boolean };

export type GatusResult = {
  hostname?: string;
  duration: number;
  conditionResults: GatusConditionResult[];
  success: boolean;
  timestamp: string;
};

export type GatusEndpoint = {
  name: string;
  group: string;
  key: string;
  results: GatusResult[];
};

export async function fetchDeployments(limit = 50): Promise<Deployment[]> {
  const res = await fetch(`/api/deployments?limit=${limit}`);
  if (!res.ok) throw new Error(`deployments: HTTP ${res.status}`);
  return res.json();
}

export async function fetchGatusStatuses(): Promise<GatusEndpoint[]> {
  const res = await fetch("/api/gatus/api/v1/endpoints/statuses");
  if (!res.ok) throw new Error(`gatus: HTTP ${res.status}`);
  return res.json();
}

export type PodEvent = {
  id: string;
  uid: string;
  namespace: string;
  involved_kind: string;
  involved_name: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  source: string;
  count: number;
  first_seen: string;
  last_seen: string;
};

export async function fetchPodEvents(opts: { type?: "Warning" | "Normal"; limit?: number } = {}): Promise<PodEvent[]> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  params.set("limit", String(opts.limit ?? 50));
  const res = await fetch(`/api/pod_events?${params}`);
  if (!res.ok) throw new Error(`pod_events: HTTP ${res.status}`);
  return res.json();
}
