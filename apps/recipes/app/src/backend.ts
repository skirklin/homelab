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

// Initialize shared backend (PocketBase)
import { initializeBackend } from "@kirkl/shared";
initializeBackend();

// ============================================
// API client functions
// ============================================

export const getRecipes = async (args: { url: string | undefined }): Promise<{ data: { error?: string; recipes: string } }> => {
  const result = await apiFetch<{ recipes: string; error?: string }>("/recipes/scrape", {
    body: { url: args.url },
  });
  return { data: { recipes: result.recipes, error: result.error } };
};

export const generateRecipe = async (args: { prompt: string }): Promise<{ data: { recipeJson: string } }> => {
  const result = await apiFetch<{ recipeJson: string }>("/ai/generate", {
    body: { prompt: args.prompt },
  });
  return { data: result };
};

export const enrichRecipeManual = async (args: { boxId: string; recipeId: string }): Promise<{ data: { success: boolean; enrichment: unknown } }> => {
  const result = await apiFetch<{ success: boolean; enrichment: unknown }>("/ai/enrich", {
    body: args,
  });
  return { data: result };
};

export const modifyRecipe = async (args: { boxId: string; recipeId: string; feedback: string }): Promise<{ data: { success: boolean; modificationJson: string } }> => {
  const result = await apiFetch<{ success: boolean; modificationJson: string }>("/ai/modify", {
    body: args,
  });
  return { data: result };
};

export const createShareInvite = async (args: { targetType: "box" | "recipe"; targetId: string }): Promise<{ data: { code: string; url: string } }> => {
  const result = await apiFetch<{ code: string; url: string }>("/sharing/invite", { body: args });
  return { data: result };
};

export const getOwnerInfo = async (args: { ownerIds: string[] }): Promise<{ data: { owners: { uid: string; name: string | null; email: string | null }[] } }> => {
  const ids = args.ownerIds.join(",");
  const result = await apiFetch<{ owners: { uid: string; name: string | null; email: string | null }[] }>(
    `/sharing/owner-info?ids=${encodeURIComponent(ids)}`,
  );
  return { data: result };
};
