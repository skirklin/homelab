/**
 * Coach service — Phase D realtime Coach Agent.
 *
 * D1 scaffolding: only a health endpoint. The SDK `query()` loop, PB
 * realtime subscription on `chat_messages`, and chat writeback land in
 * D2 — see `apps/life/OBSERVER_BUILD_PLAN.md` §"Phase D".
 *
 * Env vars the service expects (set up but not yet consumed in D1):
 *   - ANTHROPIC_API_KEY — pay-per-token billing
 *   - CLAUDE_CODE_OAUTH_TOKEN — subscription billing on Max (preferred when set)
 *   - HOMELAB_API_TOKEN — `hlk_` token for posting back to the homelab MCP
 *   - PB_URL + PB_ADMIN_EMAIL + PB_ADMIN_PASSWORD — admin PB client backing
 *     PocketBaseSessionStore
 *
 * Port: 3030 (api/functions uses 3000, ingest uses 5555).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

// Health endpoint — Gatus polls this for uptime monitoring. Identical body
// shape to services/api's `/health` so the same Gatus condition syntax
// (`[BODY].status == ok`) works.
app.get("/health", (c) => c.json({ status: "ok", service: "coach" }));

const port = Number(process.env.PORT) || 3030;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`coach service listening on port ${info.port}`);
});
