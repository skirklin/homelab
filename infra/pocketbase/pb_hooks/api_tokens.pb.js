/// <reference path="../pb_data/types.d.ts" />

/**
 * api_tokens.roles silent-strip hook — closes auth-policy §8.1.
 *
 * Background:
 *   Migration 0025 added a `roles` JSON field to `api_tokens` so the
 *   single infra token (HOMELAB_API_TOKEN) can be stamped with
 *   `roles: ["infra"]` and admitted to write the global infra
 *   collections (`deployments`, `pod_events`). The auth middleware in
 *   services/api/src/middleware/auth.ts trusts whatever value is in
 *   that field at validation time.
 *
 *   Migration 0024 tightened `api_tokens.createRule` to
 *   `user = @request.auth.id` — gating ROW INSERTION by ownership but
 *   not gating individual fields. PB has no per-field rule expression;
 *   the rule grants the entire row's allow-set.
 *
 *   Together this is the exploit: any authenticated user can POST
 *
 *     POST /api/collections/api_tokens/records
 *     { user: <self>, token_hash, token_prefix, roles: ["infra"] }
 *
 *   and self-elevate. The auth middleware then admits their token to
 *   /data/deployments and /data/pod_events.
 *
 * Defense — silent strip:
 *   Intercept create/update on api_tokens. If the request's auth is NOT
 *   a superuser, blank `roles` to []. Silent (don't throw) so that an
 *   attacker can't enumerate `roles` as a privileged field via a
 *   distinguishing error response — an honest call would have left
 *   roles empty anyway, so the observable behavior is identical for
 *   both honest and malicious callers.
 *
 *   Discriminator: the auth record's collection name. In PB 0.25's goja
 *   runtime we go through the method (`auth.collection().name`) rather
 *   than the `auth.collectionName` property used by sharing.pb.js —
 *   that property is undefined here, so a `=== "_superusers"` check
 *   against it would be unconditionally false and we would strip even
 *   the legit operator-stamping path (closed-fail rather than open-fail,
 *   but still observably broken). The method form actually returns the
 *   collection so the operator path passes through.
 *
 *   The legit user path (Settings UI / /auth/tokens endpoint) never
 *   sends `roles` in the payload, so the strip is a no-op for it.
 *
 *   Update is wired as belt-and-suspenders: today `api_tokens.updateRule`
 *   is `null` (immutable from PB-direct), so this branch never fires in
 *   practice — but if the rule is ever relaxed (e.g. to allow renaming
 *   a token), the hook keeps elevation off the table.
 */

function blankRolesIfNotSuperuser(e) {
  const auth = e.requestInfo()?.auth;
  // In PB 0.25 goja runtime, the auth record's collection is reached via
  // a method call, not a property: `auth.collection().name`. The string
  // property `auth.collectionName` is undefined here even though some
  // versions of the docs reference it. Use the method form so the check
  // actually fires.
  let authCollectionName = "";
  try {
    if (auth && typeof auth.collection === "function") {
      const coll = auth.collection();
      if (coll) authCollectionName = coll.name;
    }
  } catch (_) {
    // Defensive — fall through to the strip path on any error rather
    // than throw, since failing open here would re-open §8.1.
  }

  // Superuser context = PB admin UI / admin PB client. Trust it; this is
  // how the operator stamps HOMELAB_API_TOKEN with roles: ["infra"].
  if (authCollectionName === "_superusers") {
    e.next();
    return;
  }

  // Everything else — including user-token PB-direct calls — gets roles
  // forced to []. Silent: we don't throw, we don't 400, we just blank
  // the field. The exploit becomes a no-op identical to an honest create.
  e.record.set("roles", []);
  e.next();
}

onRecordCreateRequest(blankRolesIfNotSuperuser, "api_tokens");
onRecordUpdateRequest(blankRolesIfNotSuperuser, "api_tokens");
