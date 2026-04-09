import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import PocketBase from "pocketbase";

const PB_URL = process.env.PB_URL || "http://pocketbase.homelab.svc.cluster.local:8090";
const API_KEY = process.env.API_KEY || "";

/** Create a PocketBase client authenticated as the requesting user. */
export function userClient(token: string): PocketBase {
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  pb.authStore.save(token, null);
  return pb;
}

// Simple token validation cache (token -> { userId, email, expiresAt })
const tokenCache = new Map<string, { userId: string; email: string; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

function cleanCache() {
  const now = Date.now();
  for (const [key, val] of tokenCache) {
    if (val.expiresAt < now) tokenCache.delete(key);
  }
}

export async function authMiddleware(c: Context, next: Next) {
  // Check API key first (for MCP/curl)
  const apiKey = c.req.header("X-API-Key");
  if (apiKey && API_KEY && apiKey.length === API_KEY.length &&
      timingSafeEqual(Buffer.from(apiKey), Buffer.from(API_KEY))) {
    // API key auth — use a default admin identity
    const token = process.env.API_KEY_USER_TOKEN || "";
    c.set("userId", process.env.API_KEY_USER_ID || "");
    c.set("userEmail", process.env.API_KEY_USER_EMAIL || "");
    c.set("userToken", token);
    c.set("isApiKey", true);
    if (token) c.set("pb", userClient(token));
    return next();
  }

  // PocketBase token auth
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const token = authHeader.slice(7);

  // Check cache
  cleanCache();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("userId", cached.userId);
    c.set("userEmail", cached.email);
    c.set("userToken", token);
    c.set("pb", userClient(token));
    return next();
  }

  // Validate against PocketBase
  try {
    const pb = new PocketBase(PB_URL);
    pb.authStore.save(token, null);
    const result = await pb.collection("users").authRefresh({ $autoCancel: false });
    const userId = result.record.id;
    const email = result.record.email as string;

    tokenCache.set(token, {
      userId,
      email,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    c.set("userId", userId);
    c.set("userEmail", email);
    c.set("userToken", token);
    c.set("pb", userClient(token));
    return next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
