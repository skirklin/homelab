/**
 * Sharing routes — create invite links for sharing recipe boxes and recipes.
 * Invite redemption happens via PocketBase hook (pb_hooks/sharing.pb.js).
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { randomBytes } from "crypto";

import { RECIPES_BASE_URL, TRAVEL_BASE_URL } from "../config";

const TARGET_BASE_URLS: Record<string, string> = {
  box: RECIPES_BASE_URL,
  recipe: RECIPES_BASE_URL,
  travel_log: TRAVEL_BASE_URL,
};

export const sharingRoutes = new Hono<AppEnv>();

// Create a sharing invite for a box, recipe, or travel log
sharingRoutes.post("/invite", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { targetType, targetId, expiresAt } = await c.req.json<{
    targetType: "box" | "recipe" | "travel_log";
    targetId: string;
    expiresAt?: string;
  }>();

  if (!targetType || !targetId) {
    return c.json({ error: "Must provide targetType and targetId" }, 400);
  }

  const baseUrl = TARGET_BASE_URLS[targetType];
  if (!baseUrl) {
    return c.json({ error: "targetType must be 'box', 'recipe', or 'travel_log'" }, 400);
  }

  const code = randomBytes(12).toString("base64url");

  // PocketBase hook validates ownership on create
  const invite = await pb.collection("sharing_invites").create({
    code,
    target_type: targetType,
    target_id: targetId,
    created_by: userId,
    redeemed: false,
    expires_at: expiresAt || "",
  });

  return c.json({
    id: invite.id,
    code: invite.code,
    url: `${baseUrl}/invite/${invite.code}`,
    expires_at: invite.expires_at,
  });
}));

// List invites the authenticated user has created
sharingRoutes.get("/invites", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const invites = await pb.collection("sharing_invites").getFullList({
    filter: pb.filter("created_by = {:userId}", { userId }),
    sort: "-created",
  });
  return c.json(invites.map((i) => ({
    id: i.id,
    code: i.code,
    target_type: i.target_type,
    target_id: i.target_id,
    redeemed: i.redeemed,
    redeemed_by: i.redeemed_by,
    expires_at: i.expires_at,
    created: i.created,
    url: TARGET_BASE_URLS[i.target_type as string]
      ? `${TARGET_BASE_URLS[i.target_type as string]}/invite/${i.code}`
      : null,
  })));
}));

// Update an invite (currently just expires_at)
sharingRoutes.patch("/invite/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  const { expiresAt } = await c.req.json<{ expiresAt?: string }>();
  const updates: Record<string, unknown> = {};
  if (expiresAt !== undefined) updates.expires_at = expiresAt;
  if (Object.keys(updates).length === 0) return c.json({ error: "no fields provided" }, 400);

  const record = await pb.collection("sharing_invites").update(id, updates);
  return c.json({ id: record.id, expires_at: record.expires_at });
}));

// Revoke (delete) an invite
sharingRoutes.delete("/invite/:id", handler(async (c) => {
  const pb = c.get("pb");
  const id = c.req.param("id")!;
  await pb.collection("sharing_invites").delete(id);
  return c.json({ success: true });
}));

// GET /sharing/list-info is handled in index.ts (before auth middleware)

/**
 * Join a list — add the authenticated user to the list's owners.
 * Uses admin PB client to bypass owner-only update rules.
 */
sharingRoutes.post("/join-list", handler(async (c) => {
  const { getAdminPb } = await import("../lib/pb");
  const userId = c.get("userId");
  const { collection, listId } = await c.req.json<{ collection: string; listId: string }>();

  const allowed = ["shopping_lists", "task_lists", "life_logs"];
  if (!allowed.includes(collection)) {
    return c.json({ error: "Invalid collection" }, 400);
  }

  try {
    const pb = await getAdminPb();
    const record = await pb.collection(collection).getOne(listId, { $autoCancel: false });
    const owners: string[] = record.owners || [];

    if (!owners.includes(userId)) {
      owners.push(userId);
      await pb.collection(collection).update(listId, { owners }, { $autoCancel: false });
    }

    return c.json({ success: true, name: record.name });
  } catch {
    return c.json({ error: "List not found" }, 404);
  }
}));

// Get display info for a list of owner IDs
sharingRoutes.get("/owner-info", handler(async (c) => {
  const pb = c.get("pb");
  const idsParam = c.req.query("ids");
  if (!idsParam) {
    return c.json({ owners: [] });
  }

  const ownerIds = idsParam.split(",").filter(Boolean);
  if (ownerIds.length === 0) {
    return c.json({ owners: [] });
  }

  const owners = await Promise.all(
    ownerIds.map(async (uid) => {
      try {
        const user = await pb.collection("users").getOne(uid);
        return { uid, name: user.name || null, email: user.email || null };
      } catch {
        return { uid, name: null, email: null };
      }
    })
  );
  return c.json({ owners });
}));
