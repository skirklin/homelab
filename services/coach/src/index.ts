/**
 * Coach service — Phase D realtime Coach Agent.
 *
 * D2: SDK loop wired up. On boot we:
 *   1. Validate the auth env (OAuth or API key — one must be set).
 *   2. Build the AgentManager (per-user `query()` sessions, inbox queue,
 *      writeback via the existing /chat/messages route).
 *   3. Subscribe to PB `chat_messages` and forward every new `role="user"`
 *      row into the manager.
 *
 * Pod is single-replica (see infra/k8s/coach.yaml comment). Restart safely
 * reconstructs in-flight sessions from PB via the D1 SessionStore.
 *
 * Env vars:
 *   - ANTHROPIC_API_KEY        — pay-per-token billing
 *   - CLAUDE_CODE_OAUTH_TOKEN  — subscription billing on Max (preferred)
 *   - HOMELAB_API_TOKEN        — `hlk_` token, used for (a) the homelab
 *                                 MCP, (b) posting assistant messages back
 *   - HOMELAB_MCP_URL          — optional; defaults to tailnet endpoint
 *   - COACH_WRITEBACK_URL      — optional; defaults to in-cluster URL
 *   - PB_URL + PB_ADMIN_EMAIL + PB_ADMIN_PASSWORD — admin PB client
 *
 * Port: 3030 (api/functions uses 3000, ingest uses 5555).
 */
// PB JS SDK's realtime client uses EventSource. Node 22 doesn't expose it
// on globalThis (despite Web Platform parity claims), so polyfill from the
// `eventsource` npm package before any PB subscribe() call. Must run before
// any import that loads chat-subscriber → pocketbase → realtime.
import { EventSource as EventSourcePolyfill } from "eventsource";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).EventSource = EventSourcePolyfill;

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import PocketBase from "pocketbase";

import { createAgentManager, defaultDeps, type AgentManager } from "./agent.js";
import { startChatSubscriber, type ChatSubscription } from "./chat-subscriber.js";

// ─── Auth detection (log-only; SDK auto-detects from env) ────────────────────

function detectAuthMode(): "oauth" | "api_key" | "none" {
  // Both set is wrong-by-default: SDK precedence picks ANTHROPIC_API_KEY
  // (pay-per-token), but on a Max subscription OAuth has $0 marginal
  // cost. Log a loud warn so the misconfiguration is visible in pod logs;
  // don't change behavior (changing precedence would surprise anyone
  // who actually wants API-key billing despite having both set).
  if (process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      "[coach] Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; " +
        "SDK precedence selects ANTHROPIC_API_KEY. Unset it to use OAuth " +
        "subscription billing.",
    );
  }
  if (process.env.ANTHROPIC_API_KEY) return "api_key";
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "oauth";
  return "none";
}

// ─── Admin PB client (shared singleton, mirrors services/api/src/lib/pb.ts) ──

let adminPb: PocketBase | null = null;

async function getAdminPb(): Promise<PocketBase> {
  if (adminPb?.authStore.isValid) return adminPb;

  const pbUrl = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
  const email = process.env.PB_ADMIN_EMAIL || "";
  const password = process.env.PB_ADMIN_PASSWORD || "";
  if (!email || !password) {
    throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set");
  }
  const pb = new PocketBase(pbUrl);
  pb.autoCancellation(false);
  await pb.collection("_superusers").authWithPassword(email, password);
  adminPb = pb;
  return pb;
}

// ─── App + lifecycle ─────────────────────────────────────────────────────────

interface HealthState {
  authMode: "oauth" | "api_key" | "none";
  manager: AgentManager | null;
  subscription: ChatSubscription | null;
  startError: string | null;
}

const state: HealthState = {
  authMode: detectAuthMode(),
  manager: null,
  subscription: null,
  startError: null,
};

const app = new Hono();

// Health endpoint — Gatus polls this. `status` is the only field Gatus
// looks at (must be "ok"); the rest is for humans inspecting the pod.
app.get("/health", (c) =>
  c.json({
    status: state.startError ? "error" : "ok",
    service: "coach",
    auth_mode: state.authMode,
    subscription_active: state.subscription?.isActive() ?? false,
    active_sessions: state.manager?.activeSessionCount() ?? 0,
    last_error: state.manager?.lastError() ?? state.startError,
    // Per-user daily token totals. In-memory only; resets on pod restart
    // and at PT midnight (todayPacific). v1 is single-tenant (Scott), so
    // this is effectively `{ <scott-owner-id>: {...} }` — but the shape
    // is multi-user-ready when we open up the Coach.
    token_stats: state.manager?.tokenStats() ?? {},
  }),
);

const port = Number(process.env.PORT) || 3030;
serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`coach service listening on port ${info.port}`);
  console.log(`coach auth mode: ${state.authMode}`);

  // Fail-fast guard: if neither auth env is set, the SDK will fail on the
  // first turn anyway — better to log loudly at boot and refuse to spin
  // up the subscriber than to silently take messages we can't answer.
  if (state.authMode === "none") {
    state.startError =
      "Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set; refusing to start SDK loop.";
    console.error(`[coach] ${state.startError}`);
    return;
  }

  // Spin up the agent manager + chat subscription. We deliberately don't
  // crash the pod on bootstrap failure — /health flips to status:"error"
  // and Gatus will alert. Crashing would put us in a CrashLoopBackoff
  // that's harder to debug than a single failing readiness probe.
  try {
    const manager = createAgentManager(defaultDeps(getAdminPb));
    state.manager = manager;

    const pb = await getAdminPb();
    state.subscription = await startChatSubscriber(pb, manager);
    console.log("[coach] chat_messages subscription active");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.startError = `bootstrap: ${msg}`;
    console.error(`[coach] bootstrap failed: ${msg}`);
  }
});

// Graceful shutdown — close the SDK sessions so any in-flight work has a
// chance to settle before the pod is reaped.
async function shutdown(signal: string) {
  console.log(`[coach] received ${signal}, shutting down`);
  if (state.subscription) await state.subscription.close().catch(() => {});
  if (state.manager) state.manager.closeAll();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
