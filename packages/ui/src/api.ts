/**
 * Helpers for calling the Hono API service (under /fn/).
 */
import { getBackend } from "./backend";

function getApiBase(): string {
  const pbUrl = getBackend().baseURL;
  // PB URL is https://api.beta.kirkl.in, API service is at /fn/
  return pbUrl.replace(/\/$/, "") + "/fn";
}

function getAuthHeaders(): Record<string, string> {
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
