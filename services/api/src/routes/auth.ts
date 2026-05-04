/**
 * Auth routes — API token management.
 * Tokens use the format: hlk_ + 32 random bytes as base64url.
 * Only the SHA-256 hash is stored; the raw token is returned once at creation.
 */
import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { getAdminPb } from "../lib/pb";
import { tokenCache } from "../middleware/auth";

export const authRoutes = new Hono<AppEnv>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return "hlk_" + randomBytes(32).toString("base64url");
}

// Create a new API token (requires PB user auth, not API token auth)
authRoutes.post("/tokens", handler(async (c) => {
  const userId = c.get("userId");
  const userEmail = c.get("userEmail");

  // Only allow token creation via PB user auth, not via existing API token
  if (c.get("isApiKey")) {
    return c.json({ error: "Cannot create tokens using an API token. Use PocketBase auth." }, 403);
  }

  const { name, expires_in_days } = await c.req.json<{
    name: string;
    expires_in_days?: number;
  }>();

  if (!name || typeof name !== "string" || !name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const prefix = token.slice(0, 12) + "...";

  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const adminPb = await getAdminPb();
  await adminPb.collection("api_tokens").create({
    user: userId,
    name: name.trim(),
    token_hash: tokenHash,
    token_prefix: prefix,
    last_used: null,
    expires_at: expiresAt,
  });

  return c.json({
    token,
    name: name.trim(),
    prefix,
    user: userEmail,
    expires_at: expiresAt,
  });
}));

// List your tokens (no raw tokens — just metadata)
authRoutes.get("/tokens", handler(async (c) => {
  const userId = c.get("userId");

  // Use admin client to avoid API rule issues with relation field filtering
  const adminPb = await getAdminPb();
  const allTokens = await adminPb.collection("api_tokens").getFullList();
  const tokens = allTokens.filter(t => t.user === userId);

  return c.json(tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.token_prefix,
    last_used: t.last_used,
    expires_at: t.expires_at,
    created: t.created,
  })));
}));

// Revoke a token
authRoutes.delete("/tokens/:id", handler(async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!;

  // Verify the token belongs to this user before deleting
  const adminPb = await getAdminPb();
  const token = await adminPb.collection("api_tokens").getOne(id);
  if (token.user !== userId) {
    return c.json({ error: "Not your token" }, 403);
  }

  await adminPb.collection("api_tokens").delete(id);

  // Invalidate any cached auth for this token. tokenCache is now keyed by
  // sha256(rawToken), which matches `api_tokens.token_hash` directly — no
  // need to scan + recompute as we did before.
  tokenCache.delete(token.token_hash);

  return c.json({ deleted: true });
}));
