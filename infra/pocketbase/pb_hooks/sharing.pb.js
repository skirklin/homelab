/// <reference path="../pb_data/types.d.ts" />

/**
 * Sharing hooks — handles invite creation validation and redemption.
 *
 * POST /api/sharing/redeem  { code }
 *   - Validates the invite code
 *   - Adds the authenticated user to the target's owners
 *   - Wires the shared resource into the redeemer's user record
 *   - Marks the invite as redeemed
 *
 * onRecordCreateRequest("sharing_invites")
 *   - Resolves the acting principal (user-token: auth.id ; superuser-context:
 *     trust server-set record.created_by).
 *   - Verifies the actor owns the target before allowing the invite create.
 *   - Stamps record.created_by from the resolved actor (auth.id wins over
 *     any client-supplied value on the user-token path).
 *
 * --------------------------------------------------------------------------
 * Two goja sharp edges this file works around (auth-policy.md §8.12):
 *
 *   (a) The auth Record exposes `.collection()` as a METHOD, not a property.
 *       Older docs reference `auth.collectionName` — that property is
 *       undefined here, so any `=== "users"` comparison against it is
 *       unconditionally false and the discriminator silently falls into
 *       its else branch. Fix: call `auth.collection().name`.
 *
 *   (b) When a Record's JSON-array field has never been set (or comes from
 *       a multi-relation), `record.get(field)` returns a goja-wrapped Go
 *       slice that LOOKS like a JS array (Array.isArray → true) but whose
 *       `.push()` does not actually append the supplied value — it pushes
 *       `0` instead. This caused a "Must be a valid json value" save error
 *       on user.recipe_boxes and silent corruption on travel_slugs.
 *       Fix: copy into a fresh JS array via Array.prototype.slice.call(...)
 *       before mutating.
 *
 * Helpers are inlined into each callback (rather than refactored to module
 * scope) because module-level helper functions are NOT reachable from
 * inside an inline callback passed to routerAdd/onRecordCreateRequest —
 * calls throw `<name> is not defined`. The api_tokens.pb.js pattern
 * (define a named function at module scope and pass it directly as the
 * callback) works fine; what doesn't work is the mix — inline arrow
 * callback that references a module-scope helper.
 */

// ---- POST /api/sharing/redeem -------------------------------------------
routerAdd("POST", "/api/sharing/redeem", (e) => {
  // Inlined helper: see header note (b). Copy a maybe-Go-slice into a
  // fresh JS array so push/indexOf behave as standard JS values.
  function toJsArray(raw) {
    if (!raw) return [];
    try { return Array.prototype.slice.call(raw); }
    catch (_) { return []; }
  }

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
    } else if (targetType === "travel_log") {
      collection = "travel_logs";
    } else {
      return e.json(400, { error: "Unknown target type" });
    }

    const target = $app.findRecordById(collection, targetId);
    const owners = toJsArray(target.get("owners"));

    // Check if already an owner
    if (owners.indexOf(userId) === -1) {
      owners.push(userId);
      target.set("owners", owners);
      $app.save(target);
    }

    // Wire the shared resource into the redeemer's user record so the app
    // can discover it (apps read from user.recipe_boxes / user.travel_slugs,
    // not by querying collections where auth is in owners).
    const user = $app.findRecordById("users", userId);
    if (targetType === "box") {
      const boxes = toJsArray(user.get("recipe_boxes"));
      if (boxes.indexOf(targetId) === -1) {
        boxes.push(targetId);
        user.set("recipe_boxes", boxes);
        $app.save(user);
      }
    } else if (targetType === "recipe") {
      // For recipe-level shares, add the parent box to the user's list
      const boxId = target.get("box");
      if (boxId) {
        const boxes = toJsArray(user.get("recipe_boxes"));
        if (boxes.indexOf(boxId) === -1) {
          boxes.push(boxId);
          user.set("recipe_boxes", boxes);
          $app.save(user);
        }
      }
    } else if (targetType === "travel_log") {
      const slugs = user.get("travel_slugs") || {};
      // Already mapped? Skip.
      let alreadyMapped = false;
      for (const k in slugs) {
        if (slugs[k] === targetId) { alreadyMapped = true; break; }
      }
      if (!alreadyMapped) {
        const logName = target.get("name") || "shared";
        let slug = logName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shared";
        // Collision? Append a suffix.
        if (slugs[slug]) slug = slug + "-" + Date.now().toString(36);
        slugs[slug] = targetId;
        user.set("travel_slugs", slugs);
        $app.save(user);
      }
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

// ---- onRecordCreateRequest("sharing_invites") ---------------------------
//
// Ensures the creator owns the target before allowing the invite to be
// created. Works for both:
//
//   - User-token requests: discriminator picks the `"users"` branch via
//     auth.collection().name; authId = auth.id (CLIENT-SUPPLIED
//     created_by is IGNORED — we overwrite below).
//   - Superuser-context requests (API service with admin PB client):
//     discriminator falls to the else branch and trusts the server-set
//     created_by, since the API server has already verified the caller.
onRecordCreateRequest((e) => {
  const record = e.record;
  const authRecord = e.requestInfo()?.auth;

  // Inlined helper: see header note (a). Resolve the auth record's
  // collection NAME using the method form `auth.collection().name`; the
  // `auth.collectionName` property is undefined in PB v0.25 goja.
  let authCollection = "";
  if (authRecord) {
    try {
      if (authRecord.collection) {
        const coll = authRecord.collection();
        if (coll && typeof coll.name === "string") authCollection = coll.name;
      }
    } catch (_) {
      // Defensive — fall through to "" so the discriminator fails closed.
    }
  }

  let authId;
  if (authCollection === "users") {
    // Regular user. auth.id is the source of truth, period — never trust
    // a client-supplied created_by here. Pre-fix this branch was never
    // taken (auth.collectionName was undefined), so a non-owner could
    // forge created_by to a real owner and slip past the owner check.
    authId = authRecord.id;
  } else {
    // Superuser / admin context — the API server has already verified the
    // actor and stamps created_by from the JWT it validated. Trust it.
    authId = record.get("created_by");
  }

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
  } else if (targetType === "travel_log") {
    collection = "travel_logs";
  } else {
    throw new BadRequestError("Invalid target_type");
  }

  // Verify caller is an owner. Reading via indexOf on the raw owners
  // value works fine — it's the push side that goja mangles (header
  // note (b)), and we don't push here.
  const target = $app.findRecordById(collection, targetId);
  const owners = target.get("owners") || [];
  if (owners.indexOf(authId) === -1) {
    throw new ForbiddenError("Must be an owner to create invites");
  }

  // Stamp the creator — overwrites any client-supplied value on the
  // user-token path. Idempotent on the superuser path.
  record.set("created_by", authId);

  // Continue with the create
  e.next();
}, "sharing_invites");
