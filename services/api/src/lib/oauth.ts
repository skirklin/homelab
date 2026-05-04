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
 * Public-internet DCR exfiltration risk: a stranger can `POST /oauth/register`
 * with `client_name: "Claude Desktop"` and `redirect_uri: <attacker-controlled>`,
 * then social-engineer a victim into starting an authorize flow. The victim
 * sees "Authorize Claude Desktop" and approves; the auth code goes to the
 * attacker. Mitigations:
 *  1. The consent screen displays the actual redirect_uri (see /authorize GET).
 *  2. This allowlist accepts ONLY:
 *       - http://localhost / http://127.0.0.1 on any port (RFC 8252 loopback
 *         for native apps — Claude Desktop uses 33418 today, may rotate)
 *       - https://claude.ai/api/mcp/auth_callback (the exact Anthropic-hosted
 *         callback URL we've observed in the wild)
 *     Wildcards like `*.claude.ai` were tempting but any user-content host
 *     under that domain (artifact previews, embedded iframes) becomes an
 *     exfiltration vector.
 */
const ALLOWED_NON_LOOPBACK_REDIRECT_URIS = new Set<string>([
  "https://claude.ai/api/mcp/auth_callback",
]);

export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return ALLOWED_NON_LOOPBACK_REDIRECT_URIS.has(uri);
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
 * Best-effort caller IP for rate-limit keying.
 *
 * Caddy's `mcp.kirkl.in` block overwrites both `X-Forwarded-For` and
 * `X-Real-IP` with the actual TCP peer (`{http.request.remote.host}`), so
 * either header is trustworthy in production. We prefer X-Real-IP (single
 * value, never a chain — harder to misread) and fall back to the *rightmost*
 * XFF entry (the closest hop, which a public-facing Caddy will have
 * authoritatively set even if it appends rather than overwrites in some
 * future edit).
 *
 * Reading the leftmost XFF entry would be wrong here: it's whatever the
 * external client *said* it was, which lets any caller pick its own
 * rate-limit bucket. That bypass is what motivated this helper.
 */
export function getClientIp(headerLookup: (name: string) => string | undefined): string {
  const real = headerLookup("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = headerLookup("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]; // rightmost = closest trusted hop
  }
  return "unknown";
}
