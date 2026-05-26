/**
 * Helpers for calling the Hono API service (under /fn/).
 */
import { getBackend } from "./backend";

export function getApiBase(): string {
  const pbUrl = getBackend().baseURL.replace(/\/$/, "");
  // In production, PB and API share a host (api.kirkl.in/fn/).
  // In dev, the vite dev server proxies /fn/ to the local API service.
  const isLocalPb = pbUrl.includes("localhost") || pbUrl.includes("127.0.0.1");
  if (isLocalPb && typeof window !== "undefined") {
    return window.location.origin + "/fn";
  }
  return pbUrl + "/fn";
}

export function getAuthHeaders(): Record<string, string> {
  const token = getBackend().authStore.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Look up a list by ID for the join flow (uses admin PB client server-side). */
export async function getListInfo(
  collection: string,
  listId: string,
): Promise<{ id: string; name: string } | null> {
  const resp = await fetch(`${getApiBase()}/sharing/list-info/${collection}/${listId}`, {
    headers: getAuthHeaders(),
  });
  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Look up a sharing invite's target_type / target_module without redeeming.
 *
 * Used by the home shell to route /invite/:code into the correct module
 * (recipes vs travel). Public endpoint — no auth required. Returns null
 * for unknown / missing codes; callers should fall back to recipes which
 * is the historical default that still works for the most common case.
 */
export async function getInviteInfo(
  code: string,
): Promise<{ target_type: string; target_module: string | null; redeemed: boolean } | null> {
  const resp = await fetch(`${getApiBase()}/sharing/invite-info/${encodeURIComponent(code)}`, {
    headers: getAuthHeaders(),
  });
  if (!resp.ok) return null;
  return resp.json();
}

/** Join a list — adds the current user to the list's owners (server-side). */
export async function joinList(
  collection: string,
  listId: string,
): Promise<{ success: boolean; name: string } | null> {
  const resp = await fetch(`${getApiBase()}/sharing/join-list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ collection, listId }),
  });
  if (!resp.ok) return null;
  return resp.json();
}
