/**
 * Sharing routes — create invite links for sharing recipe boxes and recipes.
 * Invite redemption happens via PocketBase hook (pb_hooks/sharing.pb.js).
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { randomBytes } from "crypto";

const RECIPES_BASE_URL = process.env.RECIPES_BASE_URL || "https://recipes.beta.kirkl.in";

export const sharingRoutes = new Hono<AppEnv>();

// Create a sharing invite for a box or recipe
sharingRoutes.post("/invite", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const { targetType, targetId } = await c.req.json<{
    targetType: "box" | "recipe";
    targetId: string;
  }>();

  if (!targetType || !targetId) {
    return c.json({ error: "Must provide targetType and targetId" }, 400);
  }

  if (targetType !== "box" && targetType !== "recipe") {
    return c.json({ error: "targetType must be 'box' or 'recipe'" }, 400);
  }

  const code = randomBytes(12).toString("base64url");

  // PocketBase hook validates ownership on create
  const invite = await pb.collection("sharing_invites").create({
    code,
    target_type: targetType,
    target_id: targetId,
    created_by: userId,
    redeemed: false,
  });

  return c.json({
    code: invite.code,
    url: `${RECIPES_BASE_URL}/invite/${invite.code}`,
  });
}));

/**
 * Look up a list by ID for the join flow.
 * Uses admin PB client so it works even when the user isn't an owner yet.
 * Only returns the list name — not the full record.
 */
sharingRoutes.get("/list-info/:collection/:listId", handler(async (c) => {
  const { getAdminPb } = await import("../lib/pb");
  const collection = c.req.param("collection") ?? "";
  const listId = c.req.param("listId") ?? "";

  const allowed = ["shopping_lists", "task_lists", "life_logs"];
  if (!allowed.includes(collection)) {
    return c.json({ error: "Invalid collection" }, 400);
  }

  try {
    const pb = await getAdminPb();
    const record = await pb.collection(collection).getOne(listId, { $autoCancel: false });
    return c.json({ id: record.id, name: record.name });
  } catch {
    return c.json({ error: "List not found" }, 404);
  }
}));

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
