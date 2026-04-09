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
