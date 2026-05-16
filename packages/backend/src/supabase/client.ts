/**
 * Supabase client factory.
 *
 * Mirrors the singleton pattern used for PocketBase: one client per app
 * instance, configured from VITE env vars at startup. Use `getSupabase()`
 * everywhere downstream.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export interface SupabaseConfig {
  /** Base URL of the Kong gateway, e.g. https://supabase-kong.tail56ca88.ts.net */
  url: string;
  /** Public anon key — safe to ship in the browser bundle. RLS gates everything. */
  anonKey: string;
  /**
   * Optional storage key. Lets multiple Supabase instances coexist on the
   * same origin (e.g. while we cut over from PocketBase, we may run a
   * second non-production Supabase pointed at a staging URL).
   */
  storageKey?: string;
}

export function initializeSupabase(config: SupabaseConfig): SupabaseClient {
  if (client) return client;
  client = createClient(config.url, config.anonKey, {
    auth: {
      // Persist session in localStorage; auto-refresh JWTs before expiry.
      // This is what gives Supabase its Firebase-like "user just stays signed in" UX.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: config.storageKey,
    },
    realtime: {
      // Match the wpb queue's expectations: server emits events without
      // requiring a per-message ACK. Heartbeats every 30s.
      params: { eventsPerSecond: 10 },
      heartbeatIntervalMs: 30_000,
    },
    global: {
      headers: { "x-client-info": "homelab-frontend/0.1" },
    },
  });
  return client;
}

export function getSupabase(): SupabaseClient {
  if (!client) throw new Error("Supabase not initialized. Call initializeSupabase() first.");
  return client;
}

/** Reset the singleton — for tests only. */
export function resetSupabaseClientForTests(): void {
  client = null;
}
