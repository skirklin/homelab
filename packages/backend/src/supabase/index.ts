/**
 * Supabase backend factory — analogous to ../pocketbase/index.ts.
 *
 * Phase 3 status:
 *   - `auth` is implemented.
 *   - Data backends (shopping/recipes/upkeep/travel/life/user) are stubs
 *     and will throw on use; they'll be filled in incrementally as the
 *     translation lands. PB remains authoritative until cutover (Phase 8).
 *
 * Usage:
 *   import { initializeSupabase, createSupabaseBackends } from "@homelab/backend/supabase";
 *   initializeSupabase({ url, anonKey });
 *   const backends = createSupabaseBackends(() => getSupabase());
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAuthBackend } from "./auth";
import { SupabaseShoppingBackend } from "./shopping";
import { SupabaseUserBackend } from "./user";

export { initializeSupabase, getSupabase, type SupabaseConfig } from "./client";
export { SupabaseAuthBackend } from "./auth";
export { SupabaseShoppingBackend } from "./shopping";
export { SupabaseUserBackend } from "./user";

export function createSupabaseBackends(getClient: () => SupabaseClient) {
  const client = getClient();
  return {
    auth: new SupabaseAuthBackend(client) as import("../interfaces/auth").AuthBackend,
    shopping: new SupabaseShoppingBackend(client) as import("../interfaces/shopping").ShoppingBackend,
    user: new SupabaseUserBackend(client) as import("../interfaces/user").UserBackend,
    // Pending: recipes, upkeep, travel, life.
  };
}
