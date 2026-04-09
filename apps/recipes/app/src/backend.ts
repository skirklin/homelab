/**
 * Backend API client — calls the homelab API service for operations
 * that need server-side processing (scraping, AI, sharing).
 */
import { getBackend } from "@kirkl/shared";

// API base URL — same domain as PocketBase, under /fn/ path
function getApiUrl(): string {
  try {
    const env = import.meta.env;
    return env?.VITE_PB_URL || "https://api.beta.kirkl.in";
  } catch {
    return "https://api.beta.kirkl.in";
  }
}

async function apiFetch<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const pb = getBackend();
  const resp = await fetch(`${getApiUrl()}/fn${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${pb.authStore.token}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((err as Record<string, string>).error || `API error ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

// ============================================
// API client functions
// ============================================

export const getRecipes = async (args: { url: string | undefined }): Promise<{ error?: string; recipes: Record<string, unknown>[] }> => {
  return apiFetch<{ recipes: Record<string, unknown>[]; error?: string }>("/recipes/scrape", {
    body: { url: args.url },
  });
};

export const generateRecipe = async (args: { prompt: string }): Promise<{ recipeJson: string }> => {
  return apiFetch<{ recipeJson: string }>("/ai/generate", {
    body: { prompt: args.prompt },
  });
};

export const enrichRecipeManual = async (args: { boxId: string; recipeId: string }): Promise<{ success: boolean; enrichment: unknown }> => {
  return apiFetch<{ success: boolean; enrichment: unknown }>("/ai/enrich", {
    body: args,
  });
};

export const modifyRecipe = async (args: { boxId: string; recipeId: string; feedback: string }): Promise<{ success: boolean; modificationJson: string }> => {
  return apiFetch<{ success: boolean; modificationJson: string }>("/ai/modify", {
    body: args,
  });
};

export const createShareInvite = async (args: { targetType: "box" | "recipe"; targetId: string }): Promise<{ code: string; url: string }> => {
  return apiFetch<{ code: string; url: string }>("/sharing/invite", { body: args });
};

export const getOwnerInfo = async (args: { ownerIds: string[] }): Promise<{ owners: { uid: string; name: string | null; email: string | null }[] }> => {
  const ids = args.ownerIds.join(",");
  return apiFetch<{ owners: { uid: string; name: string | null; email: string | null }[] }>(
    `/sharing/owner-info?ids=${encodeURIComponent(ids)}`,
  );
};
