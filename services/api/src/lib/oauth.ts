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
