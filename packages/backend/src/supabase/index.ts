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

export { initializeSupabase, getSupabase, type SupabaseConfig } from "./client";
export { SupabaseAuthBackend } from "./auth";

export function createSupabaseBackends(getClient: () => SupabaseClient) {
  return {
    auth: new SupabaseAuthBackend(getClient()) as import("../interfaces/auth").AuthBackend,
    // Data backends pending — see Phase 3 plan in SUPABASE-MIGRATION.md.
  };
}
