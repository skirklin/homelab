# Authorization Policy

**Status:** Living document. First written 2026-05-19, immediately after the cross-tenant security sweep (commits `347d9ad`, `4a7eae0`, `e69f1b5`, `ebcaab1`, `5cbb081`, `54f3258`, `a8e55d2`) closed a long tail of cross-tenant write gaps and introduced the first non-tenancy authorization axis (`roles: ["infra"]`).

**Audience:** anyone touching a route under `services/api/src/routes/`, a PocketBase migration under `infra/pocketbase/pb_migrations/`, or `services/api/src/middleware/auth.ts`. Read this **before** writing any new endpoint that takes a Bearer token, returns user data, or mutates any PB record.

**Why a policy and not just code review.** The recent sweep found that the codebase had been built up ad-hoc — every collection had its own slightly different ownership pattern, route gating was inconsistent, and admin-PB-bypassing tokens (`hlk_`/`mcpat_`) had effectively no enforcement outside of routes that happened to remember to filter. We don't want to be in that position again. This document defines the model so the next ten endpoints can be measured against one rubric instead of ten ad-hoc reviews.

---

## 1. Threat model

### 1.1 What we defend against

| Threat | Realistic actor | Impact |
|---|---|---|
| **Cross-tenant data read** | Another logged-in user, or a stolen `hlk_`/`mcpat_` token holder, queries `/data/recipes/:id` or any per-tenant resource that belongs to a different user. | Disclosure of recipes, shopping lists, travel itineraries (which contain home location), tasks, life-tracking events (which include private health/medical data). |
| **Cross-tenant data write** | Same actor, on POST/PATCH/DELETE routes. | Tampering with someone else's recipes, lists, tasks; reparenting child rows into a victim's container; injecting items into someone else's grocery list. |
| **Account takeover via PB direct write** | An authed user POSTing directly to PB (not the API service) to forge an `api_tokens` row pointing at a victim. | Permanent token foothold under the victim's identity. (Fixed in migration 0024: `api_tokens.createRule` now requires `user = @request.auth.id`.) |
| **Privilege escalation via forged role** | A user-minted `hlk_` token that the operator did not intend to grant infra access to, but the holder edits PB or POSTs with `roles: ["infra"]`. | Write access to global infra state — falsify deployment history, inject pod events, retention-delete real events. |
| **OAuth code/token reuse and refresh-token replay** | Network attacker who captures a single authz code or refresh token. | Persistent foothold via reissued access tokens. (Mitigated: codes are single-use via DELETE in `oauth.ts:519`; refresh-token reuse triggers family revoke per `oauth.ts:555-559,587-601`.) |
| **MCP server exposure to the open internet** | Public traffic discovering the OAuth issuer at `mcp.tail56ca88.ts.net` — but the host is tailnet-only. | None unless the host gate is broken. The `mcpHostGate` in `index.ts:55-61` 404s anything outside `MCP_ALLOWED_HOSTS`. |
| **PII in committed fixtures or logs** | Future contributor pushes a money fixture that wasn't scrubbed. | Bank account numbers, transaction details visible in git history. (Mitigated by `services/ingest/scripts/scrub_fixture.py` with `--check`.) |

### 1.2 What we explicitly do **not** defend against

We're a single-engineer personal-app monorepo, not a SaaS. We are deliberately not trying to defend against:

- **Compromised user device.** If your browser session or laptop is owned, the attacker has your data. That's a given. We don't engineer for it.
- **Compromised admin credentials.** `PB_ADMIN_PASSWORD` from k8s `pb-admin-credentials` Secret is a master key. If it's leaked, game over. Rotate; don't try to harden against it.
- **Denial-of-service.** We have per-IP rate limits on the OAuth surface (`lib/oauth.ts:96-109`), but no global rate limits, no auto-blocking, no CDN. The threat doesn't justify the work for a personal app.
- **State-level actors.** Not in scope.
- **Side-channel attacks on the VPS.** We use HTTPS, we hash tokens, we don't do anything obviously stupid. We do not pretend to harden against timing attacks beyond the one place it matters (OAuth token compare, `oauth.ts:452-459` uses `timingSafeEqual`).
- **Insider threat among users.** Users sharing a recipe box are trusted with that box's data. No fine-grained per-recipe permissions inside a shared box.

### 1.3 Trust boundaries

There are exactly three:

1. **Public internet ↔ Caddy.** TLS terminates here. Caddy reverse-proxies to apps inside k3s.
2. **Caddy ↔ API service.** Plaintext, but inside the k3s cluster network. The API service is responsible for authorization; Caddy does not.
3. **API service / PB-direct frontend ↔ PocketBase.** Two paths converge on PB:
   - **Frontend-direct path:** the React apps in `apps/*` talk to PB at `api.kirkl.in` using a per-user PB JWT. PB **collection rules** are the only enforcement on this path.
   - **API service path:** `hlk_`/`mcpat_` tokens hit `services/api`, which calls PB using the **admin client** (`getAdminPb()`). Admin client **bypasses all collection rules**. The only enforcement is the route layer.

The two paths must enforce equivalent invariants. Where they diverge, that divergence is a bug.

---

## 2. Authorization model

Every authenticated request crosses two orthogonal gates.

### 2.1 The two axes

#### Axis 1: Tenancy — "is this the caller's data?"

Applies to **user-owned** resources (anything with an `owners` field, or a foreign-key parent that does). The caller's `userId` must appear in the resource's `owners` (for top-level) or in the parent's `owners` (for child rows).

#### Axis 2: Privilege — "is the caller authorized to perform this class of operation?"

Applies to **global / system** resources (no `owners` field; shared infrastructure state). The caller's token must carry a role marker (`tokenRoles` includes the required role).

These are independent. A given route gates on one **or** the other, never neither, occasionally both.

### 2.2 Decision tree

When designing a new route, walk this tree:

```
Does the resource have an `owners` field on it, OR a `<parent>` foreign key
that points to a row with an `owners` field?

├── YES → user-owned resource. Apply TENANCY gate.
│         Use the appropriate `userOwns*` / `userCan*` helper from
│         lib/authz.ts (proposed) or services/api/src/routes/data.ts (today).
│         For PATCH/DELETE, also strip parent-pointer fields from the body
│         (see §5.4) to block reparent attacks.
│
└── NO  → global/system resource (deployments, pod_events, future:
          backup runs, cluster config, registry quotas).
          Apply PRIVILEGE gate.
          Use requireRole(c, "...") and pick or define a role.
```

Routes that don't fit this tree should be rare. If you find yourself reaching for a third option, write it down in §8 — it's a sign the model needs to grow.

### 2.3 Why the gate isn't optional

`hlk_` and `mcpat_` tokens authenticate against the admin PB client in `services/api/src/middleware/auth.ts:73-77, 113, 156`. The admin client **ignores PB collection rules entirely**. Without route-level enforcement, every endpoint reachable by these tokens is implicitly world-readable to any token-holder. This is why every per-user write route in `data.ts` calls a `userOwns*` helper, and why every global write route calls `requireInfraRole(c)`.

PB JWT callers (frontend-direct path) get a user-scoped PB client and PB enforces collection rules — but they can **also** reach the same routes by sending the JWT as a Bearer header, in which case route-level enforcement kicks in identically. The two paths converge.

---

## 3. Resource taxonomy

Each PB collection is classified once. When adding a new collection, classify it on the way in and add it to this table.

### 3.1 User-owned collections (tenancy gate required)

All of these have an `owners` field OR a parent-pointer to a row that does. Listed with the gate helper to use.

| Collection | Parent | Helper |
|---|---|---|
| `recipe_boxes` | self (`owners`) | `userOwnsRecipeBox(pb, boxId, userId)` |
| `recipes` | `box` → `recipe_boxes` (also self `owners`) | `userCanWriteRecipe` / `userCanReadRecipe` |
| `recipe_events` (cooking log) | `box` → `recipe_boxes` | `userOwnsRecipeBox` via box id |
| `shopping_lists` | self (`owners`) | `userOwnsShoppingList` |
| `shopping_items` | `list` → `shopping_lists` | `userOwnsShoppingList` via list id |
| `shopping_history` | `list` → `shopping_lists` | `userOwnsShoppingList` via list id |
| `shopping_trips` | `list` → `shopping_lists` | `userOwnsShoppingList` via list id |
| `task_lists` | self (`owners`) | `userOwnsTaskList` |
| `tasks` | `list` → `task_lists` | `userOwnsTaskList` via list id |
| `task_events` | `list` → `task_lists` | `userOwnsTaskList` via list id |
| `life_logs` | self (`owners`) | `userOwnsLifeLog` |
| `life_events` | `log` → `life_logs` | `userOwnsLifeLog` via log id |
| `travel_logs` | self (`owners`) | `userOwnsTravelLog` |
| `travel_trips` | `log` → `travel_logs` | `userOwnsTravelLog` via log id |
| `travel_activities` | `log` → `travel_logs` | `userOwnsTravelLog` via log id |
| `travel_itineraries` | `log` → `travel_logs` | `userOwnsTravelLog` via log id |
| `sharing_invites` | self (`created_by`) | route-level `created_by = userId` check |
| `push_subscriptions` | self (`user`) | route-level `user = userId` check |
| `api_tokens` | self (`user`) | route-level `user = userId` check |
| `trip_proposals` | self (varies — verify) | needs explicit helper if not already present |
| `oauth_clients` / `oauth_codes` / `oauth_access_tokens` / `oauth_refresh_tokens` | special — admin-only at PB, OAuth-flow-mediated at the route | no helper; flow-specific gates in `routes/oauth.ts` |

**Recipe is special.** A recipe row carries its own `owners` field (the creator) **plus** inherits authorization from its parent box. Both are valid write-authorization paths. The read path additionally honors recipe-level `visibility` (`"public"`, `"unlisted"`, `"private"`). `userCanReadRecipe` encodes the full rule, mirroring the tightened PB visRule from migration 0024.

### 3.2 Global / system collections (privilege gate required)

| Collection | Required role | Reads | Writes |
|---|---|---|---|
| `deployments` | `infra` (today: write only; reads are authed-only) | any authed token | `infra` role |
| `pod_events` | `infra` (today: write only; reads are authed-only) | any authed token | `infra` role |

**Read-access policy on globals is currently inconsistent.** `GET /data/deployments` and `GET /data/pod_events` accept any authenticated token without checking role. This is intentional today (monitor frontend needs to render deployment history for any logged-in user, and we treat that data as effectively public among authed users), but the policy is: **call it out explicitly per route**. See §4.2 on the `monitoring-read` future role for the principled fix.

### 3.3 Resources that don't yet exist but probably will

If you're adding any of these, classify on entry:

- **Backup runs** (cluster backup history) → global, `infra` role
- **Registry quotas / image scan results** → global, `infra` role
- **Cluster cost metrics** → global, `monitoring-read` role (proposed §4.2)
- **Per-app feature flags** → user-owned if scoped to user; global with `admin` role if shared
- **Shared recipe collections** (cross-user curated lists) → user-owned with a `subscribers` field, similar to `recipe_boxes` today
- **Money / financial accounts** (when ingest migrates) → user-owned, even though today it's effectively single-tenant; bake the gate in from day one

---

## 4. Role taxonomy

Roles live in the `api_tokens.roles` JSON field (migration 0025). The field is an array of strings. Today only one role is defined, but the slot is built to grow.

### 4.1 Current roles

| Role | Granted to | Capabilities |
|---|---|---|
| `infra` | The single token used by `deploy.sh` and `event-watcher` (stored as `HOMELAB_API_TOKEN` in the `api-secrets` k8s Secret) | Write to `deployments`; write/delete to `pod_events` |

### 4.2 Proposed future roles

Don't create these speculatively. Create them when the second consumer asks for the same capability.

| Role | Use case | What it gates |
|---|---|---|
| `monitoring-read` | A public-ish status dashboard or a tailnet-only monitoring widget that should read `deployments` / `pod_events` but not write | Read access to global infra collections without write privilege. Add to migration if/when the read path is hardened from "any authed user" to "explicit role required". |
| `mcp` | Tokens issued by the OAuth flow; restricts what the OAuth-bearer can do | Today, `mcpat_` tokens carry an empty `roles` array — they have the same per-tenant access as a user JWT, but cannot mint, can't reach infra routes, can't elevate. Promoting `mcp` to an explicit role marker would let us tighten further (e.g. block direct PB collection access for `mcpat_` if we ever expose one). Not needed yet. |
| `admin` | Operator-level access to do things like rotate other users' tokens, audit invites, run schema migrations from the API. | Reserved. Not implemented. |

### 4.3 Naming convention

- Role names are **lowercase, hyphen-separated, no namespace prefix**: `infra`, `monitoring-read`, not `org:infra` or `INFRA_ROLE`.
- A role name should describe **what the holder is**, not what they do. `infra` (the holder is an infra component), not `can-write-deployments`.
- Two-token-holders-with-the-same-name is a smell. If `deploy.sh` and `event-watcher` need different capabilities, they should have different roles, not share `infra`. Today they share `infra` because their capabilities overlap completely (post + delete on globals).

### 4.4 Why a role array, not a single role

Future tokens may carry multiple roles. The single CI deployer token, for example, could plausibly need both `infra` (to record deployments) and `monitoring-read` (to query metrics for a deploy-health gate). The array shape costs nothing.

---

## 5. Code organization

### 5.1 Where helpers live

**Done (migration 0026 / this commit)**: the `userOwns*` / `userCan*` / `requireRole` / `stripParentPointers` helpers live in `services/api/src/lib/authz.ts` and are re-exported from `services/api/src/routes/data.ts` for backward compat. The canonical PB rule strings live in `infra/pocketbase/pb_migrations/lib/authz-rules.js` as `PB_RULES`, also re-exported from `lib/authz.ts`. Reasons:

1. Other route files will need them. Today only `routes/data.ts` uses them, but the moment a new route module (e.g. a future `routes/recipes.ts` enrichment endpoint, the existing `routes/sharing.ts` for invite creation) needs to gate by ownership, the helper either gets duplicated or imported via a tortured relative path. Extracted preemptively.
2. The auth helpers are the single most security-sensitive code in the repo. They live in a file whose name advertises that fact — anyone grepping for "authz" finds them.
3. Tests can target `lib/authz.ts` directly with unit tests in addition to the e2e cross-tenant tests, without spinning up the full Hono app.

**Caveat on cross-runtime source-of-truth**: PB v0.25's migration JSVM uses `goja_nodejs/require` with no filesystem resolver — migrations cannot `require()` arbitrary files. So `lib/authz-rules.js` is the truth for the TS side, but the migration `0026_authz_strings_source_of_truth.js` inlines a copy of the same rules. The property test `src/e2e/authz-mirror.test.ts` enforces equality between (a) the inlined rules, (b) the live PB schema, and (c) the TS helpers' decisions. Drift cannot survive CI.

```
services/api/src/
├── lib/
│   ├── authz.ts                  ← NEW: all userOwns*, userCan*, requireRole
│   ├── handler.ts
│   ├── oauth.ts
│   └── pb.ts
├── middleware/
│   └── auth.ts                   ← unchanged: token validation + cache + ctx setup
└── routes/
    ├── data.ts                   ← imports from lib/authz
    ├── oauth.ts
    └── ...
```

### 5.2 Naming convention

```ts
// Tenancy helpers — return boolean, "ok"|"denied"|"notfound", or a typed result.
userOwns<Resource>(pb, id, userId): Promise<boolean>
userCan<Verb><Resource>(pb, id, userId): Promise<"ok" | "denied" | "notfound">

// Privilege helpers — return null on success, Response on failure (so the
// caller can early-return). Identical shape to existing requireInfraRole.
requireRole(c, role: string): Response | null
requireAnyRole(c, ...roles: string[]): Response | null  // future, if needed
requireAllRoles(c, ...roles: string[]): Response | null // future
```

**Opinion: `requireInfraRole` should be generalized to `requireRole(c, "infra")` now, not later.** It's a four-line function whose name encodes the role at call-site. Inlining the role name as a string lowers the cost of adding a second role from "edit two files and rename a function" to "change one literal." File:line where this lives today: `data.ts:2636-2642`.

```ts
// proposed shape, lib/authz.ts
export function requireRole(c: Context<AppEnv>, role: string) {
  const roles = c.get("tokenRoles") ?? [];
  if (!roles.includes(role)) {
    return c.json({ error: `Forbidden: ${role} role required` }, 403);
  }
  return null;
}
```

Call sites become:

```ts
// data.ts
const denied = requireRole(c, "infra");
if (denied) return denied;
```

### 5.3 PB rules and API route gates should mirror each other

The two enforcement paths (PB-direct from frontend, API service from token) **must enforce the same invariants**. Where they diverge, that's a bug — it means one path is more permissive than the other and the model has a seam an attacker can target.

**Verified mirror today** (post-0024):

| Resource | PB rule (frontend) | API helper (token) | Mirror? |
|---|---|---|---|
| `recipes` read | `visRule` with public/owner/box-owner/authed-non-private clauses | `userCanReadRecipe` with the same clauses | yes |
| `recipes` write | `owners.id || box.owners.id` | `userCanWriteRecipe` | yes |
| `recipe_boxes` write | `owners.id` | `userOwnsRecipeBox` | yes |
| child collections (`shopping_items` etc) | parent.owners.id via `childRules` | `userOwnsShoppingList` / `userOwnsTaskList` / etc | yes |
| `deployments` / `pod_events` | admin-only (all rules null) | `requireInfraRole` | yes (both paths refuse non-infra writes; the route additionally permits authed reads) |

**Where they don't mirror — known gaps**: see §8.

### 5.4 Stripping parent-pointer fields on PATCH

Today, the PATCH routes individually strip the parent-pointer (`log`, `box`, `list`) from the request body to prevent **reparent attacks** — a user PATCH-ing a row they own to set its `list` to a victim's list id, thereby moving their row into the victim's container (or vice versa, depending on which end the gate is on).

This is currently ad-hoc per route. Proposed: a single helper:

```ts
// lib/authz.ts
export function stripParentPointers<T extends Record<string, unknown>>(
  body: T,
  ...fields: string[]
): T {
  const out = { ...body };
  for (const f of fields) delete out[f];
  return out;
}
```

Used as:

```ts
const patch = stripParentPointers(await c.req.json(), "list");
await pb.collection("shopping_items").update(id, patch);
```

**Stronger proposal**: the per-collection helper could carry the parent-field name with it, so the call site can't forget which field to strip:

```ts
// lib/authz.ts
export const shoppingItemAuthz = {
  parentField: "list" as const,
  ownsParent: userOwnsShoppingList,
};

// route
const item = await pb.collection("shopping_items").getOne(id);
if (!(await shoppingItemAuthz.ownsParent(pb, item[shoppingItemAuthz.parentField], userId))) {
  return c.json({ error: "not found" }, 404);
}
const patch = stripParentPointers(await c.req.json(), shoppingItemAuthz.parentField);
```

Verbose, but you can't forget to strip what you can't name.

### 5.5 Inline vs shared module for recipe vis logic

`userCanReadRecipe` (data.ts:164-191) is the most complex helper because of the visibility logic. The same logic needs to be in the PB rule (`visRule` in 0024), in any future server-side rendering path, and in any mobile client that ever computes "can I show this".

**Proposal**: a separate `lib/recipeAuthz.ts` module that exports:

```ts
export function canReadRecipe(recipe, userId, isBoxOwner): "ok" | "denied"
export function canWriteRecipe(recipe, userId, isBoxOwner): "ok" | "denied"
export const RECIPE_VIS_RULE: string  // the PB rule string, for migrations
```

The PB-rule string and the TS code would live in the same file, with a comment forcing future-you to update both. This is borderline — we don't have a frequent enough change cadence on recipe vis to justify the extraction yet. Flag as a §8 followup but don't block on it.

### 5.6 Test file pattern

Pattern is established and works: `services/api/src/e2e/cross-tenant-<surface>-routes.test.ts`. Each file:

1. Mints two real PB users via the admin client.
2. Creates a resource owned by user A.
3. Mints an `hlk_` token for user B.
4. Hits every write/read route with user B's token targeting user A's resources.
5. Asserts every response is `403` or `404` (we don't distinguish to avoid leaking existence).

Existing coverage:

- `cross-tenant-data-routes.test.ts` (general)
- `cross-tenant-itinerary-ops.test.ts`
- `cross-tenant-recipes-routes.test.ts`
- `cross-tenant-shopping-routes.test.ts`
- `cross-tenant-tasks-life-routes.test.ts`
- `role-gate-deployments.test.ts` (privilege axis)
- `access-rules.test.ts` (PB rule sanity)
- `filter-injection.test.ts` (PB filter param injection)

**New surfaces require a corresponding test file** before merge. The pattern is small enough that it's not a real ask.

---

## 6. Token issuance policy

### 6.1 Who can mint what

| Mint path | Can set `roles`? | Notes |
|---|---|---|
| **User Settings UI** (`apps/home/.../Settings`) | **No** — must be empty array | The Settings UI never offers a roles selector. The frontend never POSTs `roles` in the `api_tokens.create` payload. |
| **PB admin UI** (logged-in superuser) | Yes | Operator-only path. Used to stamp the `HOMELAB_API_TOKEN` PB record with `roles: ["infra"]` after migration 0025. |
| **Direct API call to PB** | **Today: yes, by anyone authed (BUG — see §8)** | `api_tokens.createRule` from 0024 is `user = @request.auth.id` but does not gate the `roles` field. A normal user can POST `{user: self, token_hash: x, roles: ["infra"]}` and self-elevate. |
| **OAuth flow (`mcpat_` issuance)** | **No** — hard-coded empty in `auth.ts:107` | The OAuth code path explicitly sets `roles: []` regardless of any `oauth_clients` configuration. |

### 6.2 Naming convention for infra tokens

When you mint a token intended for use by an infra component (deploy.sh, event-watcher, future automation), the `api_tokens.name` should match the env-var or k8s Secret that holds the raw value. This makes audit trivial — see a `last_used` ping on a token named "HOMELAB_API_TOKEN", you know exactly which workload to grep for.

Convention:

```
HOMELAB_API_TOKEN          ← used by deploy.sh + event-watcher (roles: ["infra"])
BESZEL_READ_TOKEN          ← hypothetical future tokens, name = env var
GATUS_READ_TOKEN
```

User-minted tokens get whatever name the user typed in the Settings UI; no convention required.

### 6.3 Rotation

We don't have an automated rotation policy. Today:

- **User tokens** rotate when the user deletes and re-creates in Settings. Tokens are never displayed after first creation (only the prefix is stored).
- **Infra tokens** rotate when the operator manually edits the k8s `api-secrets` Secret and the PB `api_tokens` row. The two must be edited together; there's no orchestrated rotation script.
- **OAuth `mcpat_` tokens** rotate via refresh-token exchange (`oauth.ts:543-601`). Refresh-token reuse triggers family revoke.

If we ever automate rotation, the design constraint is: **the new token must be live before the old one is invalidated**, because deploy.sh's API call happens once at end-of-run with no retry.

---

## 7. Migration playbook

When adding a new collection, new route, or new feature that touches authorization, follow this checklist:

### 7.1 Adding a new collection

1. **Classify it.** User-owned or global? Write down the answer in the migration's docblock comment, not just in this doc.
2. **Set PB collection rules to match the classification.**
   - User-owned with self-ownership: use the `ownerRule` pattern from 0001 — `'@request.auth.id != "" && @request.auth.id ?= owners.id'`.
   - User-owned with parent: use the `childRules(parentField)` helper pattern from 0001, but **with the tightened createRule from 0024** (i.e. `parentField.owners.id` membership, not just `auth.id != ""`).
   - Global / system: use the `adminOnly` block from 0022 — all five rules `null`.
3. **No collection ships with a missing rule.** A missing `listRule` means "world-readable" in PB. If you're not sure what the rule should be, copy from a similar existing collection and reason about why it applies.
4. **Add the appropriate index.** Unique indexes on hash columns, secondary indexes on common filter columns. See migrations 0004, 0022 for the pattern.

### 7.2 Adding a new route

1. **Decide the axis.** Tenancy or privilege? (See §2.2 decision tree.)
2. **Use the existing helper.** Don't re-implement `userOwns*` inline. If no helper exists for your collection, write one in `lib/authz.ts` (proposed location), with a docblock that names which PB rule it mirrors.
3. **Strip parent pointers on PATCH.** Use `stripParentPointers(body, "log")` or the proposed per-collection authz objects (§5.4).
4. **Return 404, not 403, for cross-tenant denials.** Don't leak existence. The error body should be `{error: "not found"}`, matching what the frontend sees from a true 404.
5. **Write the e2e test.** See §5.6 for the pattern. Each new route gets at least one negative test (user B cannot reach user A's resource).
6. **If you introduce a new role, update §4 of this doc.** Roles are an enumerated set; a fresh one means the model grew, which means future readers need to know it exists.

### 7.3 Adding a new token type

Don't, unless absolutely necessary. We have three (`hlk_`, `mcpat_`, PB JWT) and that's already a lot. If you really must:

1. Add the prefix to `services/api/src/middleware/auth.ts` as a new branch.
2. Cache shape (`tokenCache` value type) needs to accommodate the new branch's identity claims.
3. Decide if it sets `isApiKey: true` (admin PB client) or `false` (user PB client).
4. Update this doc's §3.1/§3.2 with whether this token can carry roles.

---

## 8. Known gaps and followups

These are gaps the policy implies but the code doesn't yet meet, or places where the model is rougher than the rest of the doc suggests. Each one is a candidate for the next-touch.

### 8.1 🚨 Self-mintable `infra` role via direct PB write

**File:** `infra/pocketbase/pb_migrations/0024_tighten_access_rules.js:36` and `0025_infra_role_field.js:23-30`.

The `api_tokens.createRule` is `'@request.auth.id != "" && user = @request.auth.id'`. This gates row insertion, but PB rules do not gate individual fields by default. The `roles` field added in 0025 has no per-field restriction.

**Exploit:** any authenticated user can POST to `api_tokens` with `{user: self, token_hash: <known>, token_prefix: "hlk_xxx", roles: ["infra"]}` and the row will be created. They then present `hlk_<raw>` to the API service, which loads the row, sees `roles: ["infra"]`, and admits the call to `/data/deployments` POST or `/data/pod_events` DELETE.

**Fix options, in order of preference:**

1. **PB hook in `infra/pocketbase/pb_hooks/`** that intercepts `api_tokens` create/update and blanks the `roles` field unless the caller is a superuser. Keeps the PB-rule string simple. (PB supports this via `onRecordBeforeCreateRequest` and similar.)
2. **Migrate `roles` off `api_tokens`** to a separate `api_token_roles` collection with admin-only write rules. Joined at auth-time in the middleware. More moving parts but enforces the principle of "only admins can grant privilege."
3. **Audit log + alert on any non-empty `roles` write that didn't come from the admin UI**. Low confidence in this as the primary defense — it's a detection control, not a prevention control.

This is the single most important followup. **Schedule it for the next touch on the auth surface.**

### 8.2 ⚠️ `GET /data/deployments` and `GET /data/pod_events` are authed-only, not role-gated

**File:** `services/api/src/routes/data.ts:2685` and `data.ts:2780`.

Reads on global infra collections accept any authed token. Per §3.2 this is intentional today (we treat infra history as effectively public-among-authed), but the policy says we should call this out. If we ever want to tighten — and the principled answer is yes, infra reads should require at minimum a `monitoring-read` role — the change is:

1. Define `monitoring-read` role in this doc.
2. Stamp it on the monitor frontend's read token.
3. Replace the unauthenticated read with `requireRole(c, "monitoring-read")` or `requireAnyRole(c, "infra", "monitoring-read")`.

### 8.3 ⚠️ `sharing_invites.createRule` is over-permissive at the PB layer

**File:** `infra/pocketbase/pb_migrations/0002_sharing_invites.js:31`.

Rule is `'@request.auth.id != ""'` — any authed user can create an invite for any target. Validation happens in a PB hook (`pb_hooks/sharing.pb.js`), which is correct in design but means the migration's PB rule alone is **not** the enforcement boundary. Worth a docblock note pointing at the hook as the real gate, and a test that the hook is doing what it claims.

### 8.4 note: `trip_proposals` collection classification not verified in this audit

`trip_proposals` exists (migrations 0010, 0011, 0013) but wasn't audited in this pass. Classify and table-stamp it in §3.1 the next time someone touches it.

### 8.5 note: unsanitized `status` parameter in `/data/travel/trips` filter

**File:** `services/api/src/routes/data.ts:1032-1035`.

```ts
const status = c.req.query("status");
const filter = status
  ? pb.filter("log = {:logId} && status = {:status}", { logId, status })
  : ...
```

This is **safe** as written — `pb.filter` parameter-binds, it's not string-interpolated. The same pattern is used throughout `data.ts` and was the subject of `filter-injection.test.ts`. Not a finding, but kept here so future readers don't re-flag it.

### 8.6 done: `requireInfraRole` generalized to `requireRole`

Per §5.2, generalized to `requireRole(c, "infra")` in `lib/authz.ts`. All four call sites in `data.ts` updated.

### 8.7 done: `stripParentPointers` helper extracted

Per §5.4, lives in `lib/authz.ts`. The two PATCH routes that had inlined `_droppedLog` destructuring (`/data/travel/trips/:id`, `/data/travel/itineraries/:id`) now call it.

### 8.8 note: `userCanReadRecipe` lives in `lib/authz.ts` but `RECIPE_VIS_RULE` is the truth for both sides

Discussed §5.5. The TS function in `lib/authz.ts` and the PB rule string in `lib/authz-rules.js` (`RECIPE_VIS_RULE`) encode the same predicate. They are exercised together by the property test `src/e2e/authz-mirror.test.ts`. A change to recipe vis logic now requires updating both, and the test catches drift.

### 8.9 note: `/oauth/revoke` is unauthenticated

**File:** `services/api/src/routes/oauth.ts:648-671`.

RFC 7009 §2.1 says revocation SHOULD authenticate the client. We don't. The risk is purely DoS — an attacker who learns a refresh token can revoke it, but they could also use it, which is strictly worse. Worth a TODO but not urgent.

### 8.10 note: OAuth `mcpat_` tokens have full per-tenant scope

The `SUPPORTED_SCOPES = ["mcp"]` in `lib/oauth.ts:9` is a single coarse scope. An `mcpat_` token holder can do **anything** the OAuth user can do via the MCP server — including writes. If/when an MCP tool is added that performs a destructive or financially-significant operation (e.g., money writes, when ingest migrates), reconsider whether OAuth scope granularity should grow. Today this is acceptable because MCP exposes only data ops the user can already perform; tomorrow it might not be.

### 8.11 note: API service uses the admin PB client across the board for token-auth callers

This is fundamental: by setting `c.set("pb", adminPb)` in `auth.ts:75, 122, 186`, every route gets a client that can read/write anything. Route-level gates are the entire enforcement. The alternative — a per-user PB JWT minted on the fly — is conceivable but materially more complex (no built-in PB API for "act as user X without their password"). We accept the design and pay for it with paranoia at the route layer. **Anyone adding a route should internalize this** — if the gate isn't there, the data isn't either, regardless of what PB rules say.

---

## 9. Quick reference

### 9.1 Cheat sheet for a new write route

```ts
import { userOwnsShoppingList, stripParentPointers } from "../lib/authz";

dataRoutes.patch("/shopping/items/:id", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId") as string;
  const id = c.req.param("id")!;

  // 1) Load and tenancy-check
  let item;
  try { item = await pb.collection("shopping_items").getOne(id); }
  catch { return c.json({ error: "not found" }, 404); }
  if (!(await userOwnsShoppingList(pb, item.list as string, userId))) {
    return c.json({ error: "not found" }, 404);  // 404 not 403, don't leak
  }

  // 2) Strip parent pointers from PATCH body
  const patch = stripParentPointers(await c.req.json(), "list");

  // 3) Apply
  const updated = await pb.collection("shopping_items").update(id, patch);
  return c.json({ id: updated.id });
}));
```

### 9.2 Cheat sheet for a new global write route

```ts
import { requireRole } from "../lib/authz";

dataRoutes.post("/deployments", handler(async (c) => {
  const denied = requireRole(c, "infra");
  if (denied) return denied;

  const pb = c.get("pb");
  const body = await c.req.json<{ ... }>();
  // validate body, then write — admin PB client, no per-user filtering
  const record = await pb.collection("deployments").create(body);
  return c.json({ id: record.id }, 201);
}));
```

### 9.3 Constants

```
Token prefixes        hlk_, mcpat_, mcprt_, mcpcd_, mcpc_, mcps_, fam_
Token storage         SHA-256 hex on disk; raw shown once
Admin PB client       services/api/src/lib/pb.ts → getAdminPb()
Auth context keys     userId, userEmail, userToken, isApiKey, tokenRoles, pb
Cache TTL             30s, keyed by hashToken(raw)
Issuer                process.env.MCP_ISSUER (prod: https://mcp.tail56ca88.ts.net)
MCP host gate         services/api/src/index.ts:55-61
```

### 9.4 When in doubt

1. If you don't know whether to gate by tenancy or privilege, **gate by both** until you do. The cost is one extra `requireRole` line; the cost of being wrong is a cross-tenant breach.
2. If you're adding the first route on a new surface, write the e2e test **first**. Cross-tenant attack tests are the easiest test to write — you mint two users, you point user B at user A's data, you assert 404/403. Five minutes.
3. If you're touching `auth.ts` or `lib/authz.ts`, ask for a Robert review. They are the only files in the repo where a typo is a CVE.

---

**End of policy.** Last reviewed by: (initial draft, security-expert agent, 2026-05-19).
