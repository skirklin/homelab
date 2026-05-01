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
