/**
 * Sharing routes — create invite links for sharing recipe boxes and recipes.
 * Invite redemption happens via PocketBase hook (pb_hooks/sharing.pb.js).
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { userClient } from "../lib/pb";
import { randomBytes } from "crypto";

export const sharingRoutes = new Hono<AppEnv>();

// Create a sharing invite for a box or recipe
sharingRoutes.post("/invite", async (c) => {
  const pb = userClient(c.get("userToken"));
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

  try {
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
      url: `https://recipes.beta.kirkl.in/invite/${invite.code}`,
    });
  } catch (err) {
    const message = (err as { message?: string })?.message || "Failed to create invite";
    console.error("Error creating invite:", message);
    return c.json({ error: message }, 500);
  }
});

// Get display info for a list of owner IDs
sharingRoutes.get("/owner-info", async (c) => {
  const pb = userClient(c.get("userToken"));
  const idsParam = c.req.query("ids");
  if (!idsParam) {
    return c.json({ owners: [] });
  }

  const ownerIds = idsParam.split(",").filter(Boolean);
  if (ownerIds.length === 0) {
    return c.json({ owners: [] });
  }

  try {
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
  } catch (err) {
    console.error("Error fetching owner info:", err);
    return c.json({ error: "Failed to fetch owner info" }, 500);
  }
});
