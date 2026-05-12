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
// host allowlist so they're tailnet-only. Empty list = unrestricted (dev). Set
// MCP_ALLOWED_HOSTS=mcp.tail56ca88.ts.net in k8s. The middleware short-circuits
// non-allowed hosts with a 404 to avoid leaking the endpoint's existence.
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

// OAuth discovery + endpoints (public, tailnet-only). Mounted before authMiddleware
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
// List info for join flow — needs to work before user is an owner
app.get("/sharing/list-info/:collection/:listId", async (c) => {
  const { getAdminPb } = await import("./lib/pb");
  const collection = c.req.param("collection") ?? "";
  const listId = c.req.param("listId") ?? "";
  const allowed = ["shopping_lists", "task_lists", "life_logs"];
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
