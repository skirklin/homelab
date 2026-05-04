import { createHash, randomBytes } from "node:crypto";

export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1h
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 90; // 90d
export const AUTH_CODE_TTL_SEC = 60 * 10; // 10min
export const SESSION_COOKIE_TTL_SEC = 60 * 60 * 24; // 24h
export const SESSION_COOKIE_NAME = "homelab_oauth_session";

export const SUPPORTED_SCOPES = ["mcp"];

export function generateOpaqueToken(prefix: string, byteLength = 32): string {
  return `${prefix}${randomBytes(byteLength).toString("base64url")}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** PKCE S256 verification: SHA256(verifier) base64url-encoded equals challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

export type OAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable";

export function buildErrorRedirect(
  redirectUri: string,
  error: OAuthError,
  state: string | undefined,
  description?: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function buildSuccessRedirect(
  redirectUri: string,
  code: string,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * DCR is publicly callable. Restrict redirect URIs to known-good patterns so
 * a stranger can't register a client that redirects auth codes to their server:
 *  - http://localhost:* and http://127.0.0.1:* — RFC 8252 native-app loopback
 *  - https://claude.ai/* — Anthropic's hosted MCP callback
 *  - https://*.anthropic.com/* — Anthropic-owned domains
 */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    if (u.protocol === "https:") {
      if (u.hostname === "claude.ai" || u.hostname.endsWith(".claude.ai")) return true;
      if (u.hostname === "anthropic.com" || u.hostname.endsWith(".anthropic.com")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- per-IP rate limiter (in-process, sliding window) ----

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  // Lazy GC: every ~1k entries, drop expired buckets to bound memory.
  if (rateBuckets.size > 1000) {
    for (const [k, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}

/**
 * Best-effort caller IP. We sit behind Caddy → functions Service, so the raw
 * socket peer is always the cluster-internal IP. The real client IP arrives in
 * X-Forwarded-For (left-most entry); fall back to remote address if that's
 * absent (dev/local tests).
 */
export function getClientIp(headerLookup: (name: string) => string | undefined): string {
  const xff = headerLookup("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headerLookup("x-real-ip");
  if (real) return real;
  return "unknown";
}
