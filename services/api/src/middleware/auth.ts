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

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
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
        return c.json({ error: "API token expired" }, 401);
      }

      // Look up the user
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
    } catch {
      return c.json({ error: "Invalid API token" }, 401);
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
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
