import type { Context, Next } from "hono";
import { createHash } from "node:crypto";
import PocketBase from "pocketbase";
import { getAdminPb } from "../lib/pb";

function getPbUrl() {
  return process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
}

/** Create a PocketBase client authenticated as the requesting user. */
export function userClient(token: string): PocketBase {
  const pb = new PocketBase(getPbUrl());
  pb.autoCancellation(false);
  pb.authStore.save(token, null);
  return pb;
}

// Token validation cache — exported so revoke can invalidate
export const tokenCache = new Map<string, { userId: string; email: string; isApiKey: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

function cleanCache() {
  const now = Date.now();
  for (const [key, val] of tokenCache) {
    if (val.expiresAt < now) tokenCache.delete(key);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * For requests to the /mcp endpoint, an unauthenticated 401 must include
 * `WWW-Authenticate: Bearer resource_metadata="..."` so MCP clients can
 * discover the OAuth flow. Browsers and curl don't care, but Claude mobile
 * relies on this header to know where to begin authorization. (RFC 9728 §5.)
 */
function mcpAuthChallengeHeader(c: Context): string | null {
  if (!c.req.path.startsWith("/mcp")) return null;
  const issuer = process.env.MCP_ISSUER || "https://mcp.tail56ca88.ts.net";
  return `Bearer realm="mcp", resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`;
}

function unauthorized(c: Context, error: string) {
  const challenge = mcpAuthChallengeHeader(c);
  if (challenge) c.header("WWW-Authenticate", challenge);
  return c.json({ error }, 401);
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorized(c, "Authentication required");
  }

  const token = authHeader.slice(7);

  // Check cache first
  cleanCache();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("userId", cached.userId);
    c.set("userEmail", cached.email);
    c.set("userToken", token);
    c.set("isApiKey", cached.isApiKey);
    if (cached.isApiKey) {
      // API tokens use the admin PB client scoped to the user's data
      const adminPb = await getAdminPb();
      c.set("pb", adminPb);
    } else {
      c.set("pb", userClient(token));
    }
    return next();
  }

  // OAuth access token auth (mcpat_ prefix) — issued by /oauth/token, scoped to the MCP server.
  // Same data-access semantics as API keys: admin PB client, results filtered by user_id in the routes.
  if (token.startsWith("mcpat_")) {
    try {
      const tokenHash = hashToken(token);
      const adminPb = await getAdminPb();
      const record = await adminPb.collection("oauth_access_tokens").getFirstListItem(
        adminPb.filter("token_hash = {:tokenHash}", { tokenHash }),
      );

      if (record.expires_at && new Date(record.expires_at) < new Date()) {
        return unauthorized(c, "Access token expired");
      }
      const user = await adminPb.collection("users").getOne(record.user);

      adminPb.collection("oauth_access_tokens").update(record.id, {
        last_used: new Date().toISOString(),
      }).catch(() => {});

      const userId = user.id;
      const email = user.email as string;

      tokenCache.set(token, {
        userId,
        email,
        isApiKey: true,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      c.set("userId", userId);
      c.set("userEmail", email);
      c.set("userToken", token);
      c.set("isApiKey", true);
      c.set("pb", adminPb);
      return next();
    } catch (err) {
      console.error("[auth] OAuth access token validation failed:", err instanceof Error ? err.message : err);
      return unauthorized(c, "Invalid access token");
    }
  }

  // API token auth (hlk_ prefix)
  if (token.startsWith("hlk_")) {
    try {
      const tokenHash = hashToken(token);
      const adminPb = await getAdminPb();
      const record = await adminPb.collection("api_tokens").getFirstListItem(
        adminPb.filter("token_hash = {:tokenHash}", { tokenHash }),
      );

      // Check expiry
      if (record.expires_at && new Date(record.expires_at) < new Date()) {
        return unauthorized(c, "API token expired");
      }
      const user = await adminPb.collection("users").getOne(record.user);

      // Update last_used (fire and forget)
      adminPb.collection("api_tokens").update(record.id, {
        last_used: new Date().toISOString(),
      }).catch(() => {});

      const userId = user.id;
      const email = user.email as string;

      tokenCache.set(token, {
        userId,
        email,
        isApiKey: true,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      c.set("userId", userId);
      c.set("userEmail", email);
      c.set("userToken", token);
      c.set("isApiKey", true);
      c.set("pb", adminPb);
      return next();
    } catch (err) {
      console.error("[auth] API token validation failed:", err instanceof Error ? err.message : err);
      return unauthorized(c, "Invalid API token");
    }
  }

  // PocketBase user token auth
  try {
    const pb = new PocketBase(getPbUrl());
    pb.authStore.save(token, null);
    const result = await pb.collection("users").authRefresh({ $autoCancel: false });
    const userId = result.record.id;
    const email = result.record.email as string;

    tokenCache.set(token, {
      userId,
      email,
      isApiKey: false,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    c.set("userId", userId);
    c.set("userEmail", email);
    c.set("userToken", token);
    c.set("isApiKey", false);
    c.set("pb", userClient(token));
    return next();
  } catch (err) {
    console.error("[auth] PB token validation failed:", err instanceof Error ? err.message : err);
    return unauthorized(c, "Invalid or expired token");
  }
}
