import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Declare context variables set by auth middleware
export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
    userToken: string;
    isApiKey: boolean;
    /**
     * Role markers stamped on the caller's `api_tokens` record. Only set
     * for hlk_ token auth (OAuth `mcpat_` tokens never carry infra roles —
     * those flow from the human OAuth consent path, never from CI). Used
     * by routes that gate infra-only writes (e.g. /data/deployments,
     * /data/pod_events). Empty array for PB-user / OAuth / unscoped paths.
     */
    tokenRoles: string[];
    pb: import("pocketbase").default;
  };
};
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { authMiddleware } from "./middleware/auth";
import { buildMcpServer } from "./mcp";
import { recipesRoutes } from "./routes/recipes";
import { aiRoutes } from "./routes/ai";
import { sharingRoutes } from "./routes/sharing";
import { dataRoutes } from "./routes/data";
import { moneyRoutes } from "./routes/money";
import { pushRoutes } from "./routes/push";
import { authRoutes } from "./routes/auth";
import { notificationRoutes } from "./routes/notifications";
import { observerRoutes } from "./routes/observer";
import { oauthRoutes } from "./routes/oauth";
import { startScheduler } from "./lib/notifications/scheduler";
import { SUPPORTED_SCOPES } from "./lib/oauth";
const app = new Hono<AppEnv>();

// CORS — allow kirkl.in and any subdomain (incl. beta.kirkl.in), plus local dev
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    const host = origin.replace(/^https?:\/\//, "").split(":")[0];
    if (host === "kirkl.in" || host.endsWith(".kirkl.in") || host === "localhost" || host.endsWith(".localhost")) {
      return origin;
    }
    return undefined;
  },
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// MCP-related endpoints (oauth + discovery + the /mcp route itself) live behind a
// host allowlist. Prod allows both the public host and the tailnet host:
// MCP_ALLOWED_HOSTS=mcp.kirkl.in,mcp.tail56ca88.ts.net (see infra/k8s/api.yaml).
// Empty list = unrestricted (dev). The middleware short-circuits non-allowed hosts
// with a 404 to avoid leaking the endpoint's existence.
const mcpAllowedHosts = (process.env.MCP_ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const mcpHostGate = async (c: import("hono").Context, next: import("hono").Next) => {
  if (mcpAllowedHosts.length > 0) {
    const host = (c.req.header("host") ?? "").toLowerCase().split(":")[0];
    if (!mcpAllowedHosts.includes(host)) return c.json({ error: "Not found" }, 404);
  }
  return next();
};

const MCP_ISSUER = process.env.MCP_ISSUER || "https://mcp.tail56ca88.ts.net";
const MCP_RESOURCE = `${MCP_ISSUER}/mcp`;

// OAuth discovery + endpoints (public — reachable at mcp.kirkl.in, also on tailnet).
// Mounted before authMiddleware
// so unauthenticated clients can complete the OAuth flow that issues the access
// tokens authMiddleware will then validate.
app.get("/.well-known/oauth-authorization-server", mcpHostGate, (c) => c.json({
  issuer: MCP_ISSUER,
  authorization_endpoint: `${MCP_ISSUER}/oauth/authorize`,
  token_endpoint: `${MCP_ISSUER}/oauth/token`,
  registration_endpoint: `${MCP_ISSUER}/oauth/register`,
  revocation_endpoint: `${MCP_ISSUER}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: SUPPORTED_SCOPES,
}));
app.get("/.well-known/oauth-protected-resource/mcp", mcpHostGate, (c) => c.json({
  resource: MCP_RESOURCE,
  authorization_servers: [MCP_ISSUER],
  scopes_supported: SUPPORTED_SCOPES,
  bearer_methods_supported: ["header"],
}));
app.use("/oauth/*", mcpHostGate);
app.use("/mcp", mcpHostGate);
app.route("/oauth", oauthRoutes);

// Public endpoints (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/push/vapid-key", (c) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return c.json({ error: "VAPID keys not configured" }, 503);
  return c.json({ publicKey: key });
});
// Backup freshness — drives the Gatus pb-backups-fresh check. Public
// (Gatus carries no auth) but reveals only the latest daily-* backup's
// age + key, no record contents. Returns 503 when no daily backup
// exists yet so Gatus surfaces "no backups" as a failure rather than
// silently reporting age=null.
app.get("/health/backups", async (c) => {
  try {
    const { getAdminPb } = await import("./lib/pb");
    const pb = await getAdminPb();
    // PB exposes the backups index via authStore's pbCollections client.
    // We need the raw HTTP route since the SDK doesn't wrap /api/backups.
    const pbUrl = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
    const res = await fetch(`${pbUrl}/api/backups`, {
      headers: { Authorization: pb.authStore.token },
    });
    if (!res.ok) return c.json({ error: "PB backups API failed", status: res.status }, 503);
    const backups = await res.json() as Array<{ key: string; size: number; modified: string }>;
    const daily = backups
      .filter((b) => b.key.startsWith("daily-"))
      .sort((a, b) => b.modified.localeCompare(a.modified));
    if (daily.length === 0) {
      return c.json({ error: "no daily backups found", age_hours: null, latest_key: null }, 503);
    }
    const latest = daily[0];
    // Normalize PB's "YYYY-MM-DD HH:MM:SS.sssZ" shape to ISO 8601 for Date().
    const iso = latest.modified.replace(" ", "T");
    const ageMs = Date.now() - new Date(iso).getTime();
    const age_hours = Math.round((ageMs / 36e5) * 10) / 10;
    return c.json({ age_hours, latest_key: latest.key, size: latest.size });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
  }
});
// Invite type lookup — needs to work before redemption so the home app
// can route /invite/:code to the right module's redeemer (recipes vs travel).
// Returns just target_type (and a sanitized "target_module" alias) so
// nothing sensitive is leaked. 404 if code is missing, expired, or already
// redeemed; the redeemer path will surface the same condition with a UX.
app.get("/sharing/invite-info/:code", async (c) => {
  const { getAdminPb } = await import("./lib/pb");
  const code = c.req.param("code") ?? "";
  if (!code) return c.json({ error: "missing code" }, 400);
  try {
    const pb = await getAdminPb();
    const invite = await pb.collection("sharing_invites").getFirstListItem(
      pb.filter("code = {:code}", { code }),
      { $autoCancel: false },
    );
    const targetType = invite.target_type as string;
    // Map invite target_type to the public-URL module prefix used by the
    // home shell. "box" and "recipe" both redeem inside the recipes module.
    const moduleMap: Record<string, string> = {
      box: "recipes",
      recipe: "recipes",
      travel_log: "travel",
    };
    const target_module = moduleMap[targetType] ?? null;
    return c.json({
      target_type: targetType,
      target_module,
      redeemed: !!invite.redeemed,
    });
  } catch {
    return c.json({ error: "Invite not found" }, 404);
  }
});
// List info for join flow — needs to work before user is an owner
app.get("/sharing/list-info/:collection/:listId", async (c) => {
  const { getAdminPb } = await import("./lib/pb");
  const collection = c.req.param("collection") ?? "";
  const listId = c.req.param("listId") ?? "";
  // life_logs intentionally excluded — life is single-owner only as of
  // migration 0028 and is no longer shareable.
  const allowed = ["shopping_lists", "task_lists"];
  if (!allowed.includes(collection)) return c.json({ error: "Invalid collection" }, 400);
  try {
    const pb = await getAdminPb();
    const record = await pb.collection(collection).getOne(listId, { $autoCancel: false });
    return c.json({ id: record.id, name: record.name });
  } catch {
    return c.json({ error: "List not found" }, 404);
  }
});

// All other routes require auth
app.use("*", authMiddleware);

// Mount route groups
app.route("/recipes", recipesRoutes);
app.route("/ai", aiRoutes);
app.route("/sharing", sharingRoutes);
app.route("/data", dataRoutes);
app.route("/money", moneyRoutes);
app.route("/push", pushRoutes);
app.route("/auth", authRoutes);
app.route("/notifications", notificationRoutes);
app.route("/observer", observerRoutes);

// MCP Streamable HTTP endpoint. Host allowlist enforced by mcpHostGate (mounted
// above before authMiddleware so non-tailnet probes get 404 without revealing
// the auth challenge); the global authMiddleware then validates the token.
app.all("/mcp", async (c) => {
  const userToken = c.get("userToken");
  const server = buildMcpServer(userToken);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const port = parseInt(process.env.PORT || "3000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API server running on port ${info.port}`);
  startScheduler();
});
