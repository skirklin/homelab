/// <reference path="../pb_data/types.d.ts" />

/**
 * Sharing hooks — handles invite creation validation and redemption.
 *
 * POST /api/sharing/redeem  { code }
 *   - Validates the invite code
 *   - Adds the authenticated user to the target's owners
 *   - Marks the invite as redeemed
 */

// Custom route: redeem an invite
routerAdd("POST", "/api/sharing/redeem", (e) => {
  const authRecord = e.auth;
  if (!authRecord) {
    return e.json(401, { error: "Authentication required" });
  }

  const body = e.requestInfo().body;
  const code = body.code;
  if (!code) {
    return e.json(400, { error: "Must provide invite code" });
  }

  // Find the invite
  let invite;
  try {
    invite = $app.findFirstRecordByFilter("sharing_invites", `code = {:code} && redeemed = false`, {
      code: code,
    });
  } catch {
    return e.json(404, { error: "Invalid or already redeemed invite" });
  }

  // Check expiry
  const expiresAt = invite.get("expires_at");
  if (expiresAt) {
    const expiry = new Date(expiresAt);
    if (expiry < new Date()) {
      return e.json(410, { error: "Invite has expired" });
    }
  }

  const targetType = invite.get("target_type");
  const targetId = invite.get("target_id");
  const userId = authRecord.id;

  // Add user to owners of the target
  try {
    let collection;
    if (targetType === "box") {
      collection = "recipe_boxes";
    } else if (targetType === "recipe") {
      collection = "recipes";
    } else {
      return e.json(400, { error: "Unknown target type" });
    }

    const target = $app.findRecordById(collection, targetId);
    const owners = target.get("owners") || [];

    // Check if already an owner
    if (owners.indexOf(userId) === -1) {
      owners.push(userId);
      target.set("owners", owners);
      $app.save(target);
    }

    // Mark invite as redeemed
    invite.set("redeemed", true);
    invite.set("redeemed_by", userId);
    $app.save(invite);

    return e.json(200, {
      success: true,
      target_type: targetType,
      target_id: targetId,
    });
  } catch (err) {
    return e.json(500, { error: "Failed to redeem invite: " + err.message });
  }
});

// Validate invite creation — ensure the creator owns the target
onRecordCreateRequest((e) => {
  const record = e.record;
  const authId = e.requestInfo()?.auth?.id;

  if (!authId) {
    throw new BadRequestError("Authentication required");
  }

  const targetType = record.get("target_type");
  const targetId = record.get("target_id");

  let collection;
  if (targetType === "box") {
    collection = "recipe_boxes";
  } else if (targetType === "recipe") {
    collection = "recipes";
  } else {
    throw new BadRequestError("Invalid target_type");
  }

  // Verify caller is an owner
  const target = $app.findRecordById(collection, targetId);
  const owners = target.get("owners") || [];
  if (owners.indexOf(authId) === -1) {
    throw new ForbiddenError("Must be an owner to create invites");
  }

  // Set the creator
  record.set("created_by", authId);

  // Continue with the create
  e.next();
}, "sharing_invites");
