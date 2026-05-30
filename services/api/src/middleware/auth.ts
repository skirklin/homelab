import type { Context, Next } from "hono";
import { createHash } from "node:crypto";
import PocketBase, { ClientResponseError } from "pocketbase";
import { getAdminPb } from "../lib/pb";

/**
 * Classify a token-validation error as "the backend is unavailable" vs "this
 * token is genuinely invalid".
 *
 * Token validation queries PocketBase. When PB is restarting/unreachable (e.g.
 * during a rollout) the query throws, and lumping that into a 401 misreports a
 * transient outage as an auth failure — which is what paged the operator via
 * the event-watcher. We must answer 503, not 401, in that case.
 *
 * PocketBase's SDK throws `ClientResponseError` with a `.status`:
 *   - 0      → network-level failure (connection refused / DNS / timeout)
 *   - 4xx    → genuine "token not found / forbidden" (404 from getFirstListItem)
 *   - 5xx    → PB itself erroring
 * `getAdminPb()` can also throw a plain `Error` when admin auth fails because
 * PB is down. Default unknown errors to backend-unavailable so deploy blips
 * stay out of the 401 bucket.
 */
export function isBackendUnavailable(err: unknown): boolean {
  if (err instanceof ClientResponseError) {
    return err.status === 0 || err.status >= 500;
  }
  // Network errors from undici/fetch and getAdminPb admin-auth failures are
  // plain Errors, not ClientResponseError — when PB is down these are the
  // common case, so default-to-503 for unknown errors is correct.
  return true;
}

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

// Token validation cache — keyed by SHA-256 hash of the raw token, NOT the
// raw token itself. Heap dumps (crash dump → log aggregator, gdb attach,
// process snapshot) shouldn't surface live bearer tokens. Revocation paths
// invalidate by hash via `tokenCache.delete(hashToken(rawToken))`.
export const tokenCache = new Map<string, { userId: string; email: string; isApiKey: boolean; roles: string[]; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

function cleanCache() {
  const now = Date.now();
  for (const [key, val] of tokenCache) {
    if (val.expiresAt < now) tokenCache.delete(key);
  }
}

export function hashToken(token: string): string {
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

// 503 for "we couldn't validate the token because the auth backend (PB) is
// unreachable", as distinct from 401 "the token is invalid". No MCP
// WWW-Authenticate challenge — that's only meaningful for a 401.
function serviceUnavailable(c: Context, error: string) {
  return c.json({ error }, 503);
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorized(c, "Authentication required");
  }

  const token = authHeader.slice(7);
  const tokenKey = hashToken(token);

  // Check cache first
  cleanCache();
  const cached = tokenCache.get(tokenKey);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("userId", cached.userId);
    c.set("userEmail", cached.email);
    c.set("userToken", token);
    c.set("isApiKey", cached.isApiKey);
    c.set("tokenRoles", cached.roles);
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

      // OAuth-issued tokens never carry infra roles. Those are reserved for
      // direct `hlk_` minting by the operator; the OAuth consent flow has no
      // path to grant `roles: ["infra"]`.
      const roles: string[] = [];

      tokenCache.set(tokenKey, {
        userId,
        email,
        isApiKey: true,
        roles,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      c.set("userId", userId);
      c.set("userEmail", email);
      c.set("userToken", token);
      c.set("isApiKey", true);
      c.set("tokenRoles", roles);
      c.set("pb", adminPb);
      return next();
    } catch (err) {
      if (isBackendUnavailable(err)) {
        console.error("[auth] OAuth access token validation: backend unavailable:", err instanceof Error ? err.message : err);
        return serviceUnavailable(c, "Authentication backend unavailable");
      }
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
      // Role markers on the api_tokens record. Only `hlk_` tokens carry these
      // — they are stamped manually (or via a follow-on migration) on the
      // single infra token used by deploy.sh + event-watcher. Defaults to
      // empty array if the field is missing/null. We accept either an array
      // or a stringified JSON array to tolerate PB's json-field serialization
      // quirks across versions.
      const rawRoles = (record as { roles?: unknown }).roles;
      let roles: string[] = [];
      if (Array.isArray(rawRoles)) {
        roles = rawRoles.filter((r): r is string => typeof r === "string");
      } else if (typeof rawRoles === "string" && rawRoles.length > 0) {
        try {
          const parsed = JSON.parse(rawRoles);
          if (Array.isArray(parsed)) {
            roles = parsed.filter((r): r is string => typeof r === "string");
          }
        } catch {
          // ignore — treat as no roles
        }
      }

      tokenCache.set(tokenKey, {
        userId,
        email,
        isApiKey: true,
        roles,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      c.set("userId", userId);
      c.set("userEmail", email);
      c.set("userToken", token);
      c.set("isApiKey", true);
      c.set("tokenRoles", roles);
      c.set("pb", adminPb);
      return next();
    } catch (err) {
      if (isBackendUnavailable(err)) {
        console.error("[auth] API token validation: backend unavailable:", err instanceof Error ? err.message : err);
        return serviceUnavailable(c, "Authentication backend unavailable");
      }
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

    // PB user JWTs never carry infra roles — those live on api_tokens only.
    const roles: string[] = [];

    tokenCache.set(tokenKey, {
      userId,
      email,
      isApiKey: false,
      roles,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    c.set("userId", userId);
    c.set("userEmail", email);
    c.set("userToken", token);
    c.set("isApiKey", false);
    c.set("tokenRoles", roles);
    c.set("pb", userClient(token));
    return next();
  } catch (err) {
    if (isBackendUnavailable(err)) {
      console.error("[auth] PB token validation: backend unavailable:", err instanceof Error ? err.message : err);
      return serviceUnavailable(c, "Authentication backend unavailable");
    }
    console.error("[auth] PB token validation failed:", err instanceof Error ? err.message : err);
    return unauthorized(c, "Invalid or expired token");
  }
}
