# Supabase migration — status + plan

Working document. Drafted 2026-05-13, switched from "plan" to "in flight"
2026-05-14. Current as of 2026-05-16.

**Phase 1, 2, 3 are landed.** Stack is running on the cluster, schema +
RLS are applied, and `@homelab/backend` has full Supabase implementations
of every interface. PocketBase remains authoritative — no app code calls
the Supabase backends yet.

If you're picking this up cold, read the "Quick start" section, the
"Status" table, then "Gotchas" before touching anything.

---

## Quick start (resume after context loss)

```bash
# 1. Where things live
infra/k8s/supabase.yaml                       # the whole stack
infra/supabase/schema.sql                     # tables + RLS + publication
infra/scripts/bootstrap-supabase-secrets.sh   # creates supabase-secrets (out-of-band)
infra/scripts/sync-supabase-schema.sh         # re-apply schema.sql (idempotent)
infra/scripts/_sign-supabase-jwts.mjs         # JWT signer used by bootstrap
services/scripts/pb-schema-summary.py         # dump live PB schema for translation
packages/backend/src/supabase/                # all 7 backend impls
~/.config/supabase/postgres.password          # local-only, mode 600
~/.config/supabase/.pgpass                    # ditto, psql picks it up

# 2. Tailnet URLs (no public DNS yet)
https://supabase-studio.tail56ca88.ts.net/    # admin UI (dashboard creds in supabase-secrets)
https://supabase-kong.tail56ca88.ts.net/      # API gateway
postgres://postgres:<pwd>@supabase-db.tail56ca88.ts.net:5432/postgres

# 3. Verify it's all alive
ssh scott@5.78.200.161 'kubectl get pods -n homelab -l app.kubernetes.io/part-of=supabase'
ssh scott@5.78.200.161 'kubectl exec -n homelab supabase-db-0 -- env PGPASSWORD=$(cat ~/.config/supabase/postgres.password) psql -U supabase_admin -d postgres -c "\dt public.*"'

# 4. Type-check the supabase backend impls
pnpm -F @homelab/backend typecheck

# 5. Re-apply schema after editing schema.sql
./infra/scripts/sync-supabase-schema.sh
```

**Hard rule throughout:** PocketBase keeps serving production. Nothing on
kirkl.in changes until Phase 8 cutover. `wpb.resync()` stays in place
until then — users depend on it.

---

## Status

| Phase | Work | Status | Notes |
|---|---|---|---|
| 1 | Stand up Supabase self-hosted in k3s | ✅ Done | `4cf323f`. 100% tailnet-internal. Gatus checks green. |
| 2 | Schema + RLS + publication | ✅ Done | `4cf323f` + `8e4471d` schema fix. 36 tables (23 main + 8 junctions + user_profiles + 4 admin), all FORCE RLS. |
| 3 | `packages/backend/src/supabase/*.ts` | ✅ Done | All 7 backends implemented + type-checked. Commits `bcbc169`, `be7464e`, `6d90b80`, `ab202cd`, `8e4471d`, `81036ab`, `dfb7ae3`. No optimistic write wrapper yet (see Gotchas). |
| 4 | Realtime adapter pattern for `wpb` | ⏳ Pending | Phase 3 impls use raw `client.channel().on('postgres_changes')`. The wpb queue/composeView layer hasn't been ported. Apps still use PB's wpb. |
| 5 | Port `services/api/` to supabase-js admin client | ⏳ Pending | `services/api/src/lib/pb.ts` still points at PocketBase. The MCP server, recipe scraper, sharing endpoints all go through it. |
| 6 | Sharing hooks → Edge Functions or Postgres triggers | ⏳ Pending | `infra/pocketbase/pb_hooks/sharing.pb.js` (invite redemption logic) needs a Supabase home. Easiest is a Postgres trigger on `sharing_invites` UPDATE. |
| 7 | PB → Supabase data migration script | ⏳ Pending | Pattern: build a PB-id → new-UUID map per table, write to `legacy_pb_id` columns, then backfill cross-table FKs. Reuse FB→PB script lessons from `services/scripts/migrate-firebase.ts`. |
| 8 | Parallel-run + cutover | ⏳ Pending | Switch `packages/ui/src/backend.ts` default, flip Caddy routes, force password reset (see "Auth migration" below). |

---

## Commit trail (all Phase 1-3 work)

```
dfb7ae3 supabase: TravelBackend impl — phase 3 complete
81036ab supabase: UpkeepBackend impl (phase 3)
8e4471d supabase: RecipesBackend impl (phase 3)
ab202cd supabase: LifeBackend impl (phase 3)
6d90b80 supabase: UserBackend impl (phase 3)
be7464e supabase: ShoppingBackend impl (phase 3)
bcbc169 supabase: phase 3 scaffolding + AuthBackend impl
4cf323f supabase: stand up stack and define schema (migration phases 1-2)
```

Parallel sessions also landed `382f25c` (architectural-options doc),
`0324f47` (wpb retry queue), and `102f9b0` (shared SyncDot) during this
work. No conflicts.

---

## Phase 1 — what was actually deployed

| Component | Image |
|---|---|
| Postgres | `supabase/postgres:15.6.1.143` |
| GoTrue | `supabase/gotrue:v2.158.1` |
| PostgREST | `postgrest/postgrest:v12.2.0` |
| Realtime | `supabase/realtime:v2.30.34` |
| postgres-meta | `supabase/postgres-meta:v0.84.2` |
| Studio | `supabase/studio:20241014-c083b3b` |
| Kong | `kong:3.4` (3.x required — see Gotcha #2) |

Two one-shot Jobs:
- `supabase-bootstrap` — sets passwords on roles `migrate.sh` doesn't,
  creates the `_realtime` schema, seeds the Realtime tenant row
- `supabase-schema-migrate` — applies `infra/supabase/schema.sql`

Storage-API + ImgProxy + Edge Functions deferred per design.

Tailnet exposure (no public DNS):
- `supabase-studio` via Tailscale Ingress
- `supabase-kong` via Tailscale Ingress (Studio's browser bundle calls Kong by this hostname)
- `supabase-db` via `Service type=LoadBalancer loadBalancerClass=tailscale` (raw TCP for psql/DBeaver)

---

## Phase 2 — schema design choices

- **UUID primary keys + `legacy_pb_id text UNIQUE`** on every table. Phase 7
  data migration writes PB's 15-char IDs into `legacy_pb_id` and uses it
  to backfill cross-table FKs (PB IDs → new UUIDs).
- **Junction tables for ownership**: `shopping_list_owners`, `recipe_box_owners`,
  `recipe_box_subscribers`, `recipe_owners`, `life_log_owners`, `task_list_owners`,
  `task_notify_users`, `travel_log_owners`. PB stored these as comma-separated
  relation columns.
- **`user_profiles`** (1:1 with `auth.users`) holds the homelab-specific
  profile fields PB kept on its users row (slugs, fcm_tokens, recipe_boxes,
  upkeep_notification_mode, timezone, etc.).
- **RLS mirrors PB 1:1** — same permissiveness, no tightening. Helper
  functions like `is_shopping_list_owner(uuid)` are `SECURITY DEFINER STABLE`
  so policies can read junction tables without recursion.
- **Realtime publication** scoped to user-data tables (28 of 36). Excluded:
  `api_tokens`, `oauth_*`, `push_subscriptions`, `deployments`, `pod_events` —
  their CDC stream would leak secrets.
- **`REPLICA IDENTITY FULL`** on `shopping_items`, `recipes`, `tasks` so
  UPDATE events on the Realtime stream include OLD column values.

---

## Phase 3 — what each backend covers

```
packages/backend/src/supabase/
  client.ts      — initializeSupabase(config), getSupabase() singleton
  auth.ts        — AuthBackend + Firebase-parity extras (signInWithMagicLink, requestPasswordReset, updatePassword)
  shopping.ts    — ShoppingBackend. ON CONFLICT (list_id,ingredient) for history upsert.
  user.ts        — UserBackend. JSONB slug RMW + upsert provisioning.
  life.ts        — LifeBackend. getOrCreateLog recovery chain (pointer → adoption → create).
  recipes.ts     — RecipesBackend. Visibility cascades enforced by RLS, not in the impl.
  upkeep.ts      — UpkeepBackend. Materialized-path tree, syncLastCompleted on event change.
  travel.ts      — TravelBackend. 5-table per-log subscription, travel_slugs.default pointer recovery.
  index.ts       — createSupabaseBackends(getClient) factory
```

All subscriptions follow the same shape: open a Supabase Realtime channel
filtered by parent ID, load initial state **after** the channel reaches
`SUBSCRIBED` status (avoids the race where an insert lands between
`subscribe()` returning and the channel actually attaching).

---

## Gotchas (discovered during apply — don't relearn these)

1. **`POSTGRES_USER` must be `supabase_admin`**, not `postgres`. The
   `supabase/postgres` image's `migrate.sh` connects as `supabase_admin` to
   run init scripts. That role is created by `initdb` itself — so
   `POSTGRES_USER` has to BE it. Originally set wrong; cost a full PVC
   wipe to recover.

2. **Kong 2.8.1 declarative config does NOT expand `$VAR`**. The literal
   string `$SUPABASE_ANON_KEY` becomes the key-auth credential, breaking
   everything routed through Kong. We use `kong:3.4` + `KONG_VAULTS=bundled`
   + `{vault://env/SUPABASE_ANON_KEY}` syntax.

3. **`migrate.sh` only sets passwords for `supabase_admin` and `postgres`** —
   the other 6 roles (`authenticator`, `supabase_auth_admin`, etc.) get
   created without passwords. The `supabase-bootstrap` Job runs
   `ALTER USER ... WITH PASSWORD` for each. If you re-init the DB, that
   Job needs to run before GoTrue/PostgREST/Realtime stop crash-looping.

4. **Schema name mismatch**: `supabase/postgres:15.6.1.143` creates the
   `realtime` schema; `supabase/realtime:v2.30.34` expects `_realtime`.
   The bootstrap Job creates `_realtime AUTHORIZATION supabase_admin`
   so Realtime's Ecto migrator can build its tables there.

5. **Readiness probes**: Realtime, Kong, Postgres all use `tcpSocket` (or
   `pg_isready` for Postgres) — HTTP probes flap. Don't change them back
   to httpGet.

6. **`loadBalancerClass: tailscale` works** in this cluster's operator
   install (the only TCP-LB Service in the repo). Verified at apply; flagged
   as unverified during planning. The operator provisions a tailnet device
   automatically.

7. **`recipe_boxes` on user_profiles is an array, not an object.** PB
   stored it as a JSON array of box IDs (unlike slug fields which are
   keyed objects). Schema defaults to `'[]'::jsonb`; Phase 8 data
   migration must respect this shape.

8. **No optimistic write wrapper** for Supabase yet. PB's `wpb` does
   sub-frame echo of writes; the Supabase impls just `await` the network
   round-trip. Apps may feel laggier on first test. Phase 4 should build
   the equivalent.

9. **`AuthBackend` interface lacks magic-link/reset/email-verify** — those
   are implemented on `SupabaseAuthBackend` as bonus methods, but callers
   targeting Supabase have to downcast. Interface widening is a Phase 3.5
   follow-up that should also backfill a `PocketBaseAuthBackend` (the
   interface currently has no PB implementation at all; PB auth is wired
   directly via `pb.authStore` in `packages/ui/src/auth.tsx`).

10. **Parallel Claude sessions** are common on this repo. Use `git diff
    HEAD -- <specific path>` before staging — there's almost always
    unrelated dirty state from another session. See [feedback_no_stash_parallel_claudes.md](.claude/projects/-home-skirklin-projects-homelab/memory/feedback_no_stash_parallel_claudes.md).

---

## Phase 4 (next) — wpb-equivalent for Supabase

The current Phase 3 backends call `client.channel().on('postgres_changes')`
directly. PB's [wpb](packages/backend/src/wrapped-pb/index.ts) wraps every
write with: synchronous local echo, a per-record queue, a composed view,
and a resync hook for SDK reconnects.

Phase 4 should pull the queue/view logic out of wpb into a backend-agnostic
layer, with a Supabase-specific subscription driver. Sketch:

```
packages/backend/src/wrapped/      <- renamed from wrapped-pb/
  queue.ts                         <- unchanged, already backend-agnostic
  persistence.ts                   <- unchanged
  index.ts                         <- core (queue + view); pluggable driver
  drivers/pocketbase.ts            <- existing PB subscribe/publish
  drivers/supabase.ts              <- new: channel().on(), client.from().insert/update/delete
```

Each Supabase backend constructs the wrapped client via the supabase
driver and uses it identically to how the PB impls use wpb today.

---

## Phase 5 — port `services/api/`

`services/api/src/lib/pb.ts` constructs an authed PocketBase admin client.
Replace with a Supabase admin client using `SUPABASE_SERVICE_ROLE_KEY`.

Files that import the PB admin: recipe scraping, AI enrichment, sharing
endpoints, push notification dispatch, MCP server data routes. The shapes
are PB-record-flavored throughout (`r.id`, `r.created`, snake_case fields);
they become Supabase row shapes (`r.id`, `r.created_at`, snake_case
preserved) — mostly a search-and-replace plus a type swap, but the row
naming differences matter (e.g. `list_id` not `list`).

---

## Phase 6 — sharing hooks

`infra/pocketbase/pb_hooks/sharing.pb.js` handles invite redemption (adds
the redeemer to `recipe_boxes.owners` / `travel_logs.owners` / etc.
depending on `sharing_invites.target_type`).

Two options:
- **Postgres trigger** on `sharing_invites` AFTER UPDATE WHEN
  (NEW.redeemed AND NOT OLD.redeemed). Single-file SQL. Reuses the
  junction tables. Easiest.
- **Supabase Edge Function** in Deno. More flexible (can call out to
  push-notification service, etc.) but more moving parts.

Recommendation: trigger, unless we need cross-service effects.

---

## Phase 7 — data migration script

Pattern: `services/scripts/migrate-pb-to-supabase.ts`, mirroring the FB→PB
script in `services/scripts/migrate-firebase.ts`. Idempotent.

Per table:
1. Read all PB records via `pb.collection(name).getFullList()`.
2. Build a PB-id → new-UUID map. Insert into Supabase with `legacy_pb_id`
   set to the PB ID and the new UUID generated client-side.
3. After all tables are migrated, walk a second time and rewrite FK
   columns (e.g. `shopping_items.list_id`) from "PB ID stored as text" to
   "new UUID looked up via `legacy_pb_id`".
4. For ownership: split PB's comma-separated `owners` field, look up each
   user's new UUID, insert one row per `<thing>_owners(thing_id,
   user_id)`.

Auth migration is separate — see "Auth migration" section below for
GoTrue's bcrypt vs PB's Argon2id problem.

Validate after import: row counts match, sample queries return the same
shapes app code expects.

---

## Phase 8 — cutover

The user-visible flip. Sequence:

1. Run the Phase 7 migration script against the live PB.
2. Force password reset email to all users via GoTrue admin API.
3. Flip `packages/ui/src/backend.ts` to construct a Supabase client
   instead of PB. Apps now read/write Supabase exclusively.
4. Update Caddyfile: `api.kirkl.in` routes to `supabase-kong` instead of
   `pocketbase`. Drop the PB Service after a soak period.
5. Keep PB up read-only for ~2 weeks as a safety net. Then delete its
   StatefulSet + PVC.

---

## Auth migration (Phase 8 detail)

GoTrue stores password hashes as bcrypt; PB uses Argon2id. Can't transfer
hashes directly. Options:

1. **Force password reset on cutover (recommended)**. Users get a
   "we upgraded; please reset" email. Simplest, no security compromises.
2. Side-by-side login during a transition week. More complex, no real win.
3. Custom rehash on first login via an Edge Function intercepting
   GoTrue's sign-in. Possible but touches GoTrue internals. Not worth it
   for ~10 users.

OAuth identities migrate cleanly — same provider, just a new OAuth client
configured server-side. The user's `sub` claim is what matters.

**Stale plan note**: the original doc said password hash migration was
impossible. GoTrue has supported custom hash imports for ~1 year. Worth
re-validating before Phase 8 — option 3 may now be cheaper than (1).

---

## Why Supabase (original rationale, kept for context)

- **Realtime quality**: Postgres logical-replication-backed change stream
  is sequence-numbered server-side. Phoenix Channels on WebSocket beats
  PB's bare SSE on connection resilience.
  **Important caveat (see also `ELECTRIC-SQL-MIGRATION.md`)**: the
  `realtime-js` client SDK does *not* expose a per-subscription cursor.
  On reconnect, you re-subscribe and start from "live now"; you still need
  a `resync()`-style refetch to catch up on what you missed. Better
  transport but the same protocol gap PB has. If proper resumable sync is
  the requirement (not just a more reliable connection), see Electric or
  the custom sync-engine option, not this doc.
- **Auth bundled**: GoTrue ships with the stack — email/password, OAuth,
  magic links, JWT issuance, RLS integration. Same paradigm as Firebase Auth.
- **Closest to current model**: PB's "REST + collection rules + realtime
  subscriptions" mental model maps cleanly to "REST/SQL + RLS + realtime
  subscriptions" — same shape, more powerful backend.
- **Operational reality**: Self-hostable. ~10 containers (we run 7).
  Tolerable on the existing k3s cluster.

Alternatives considered and rejected:
- **CouchDB + PouchDB**: best transcript-like semantics, highest migration cost.
- **SurrealDB**: `LIVE SELECT` is first-class. Newer, less battle-tested.
- **Convex**: hosted-only — step backward on "own the infra" principle.
- **Replicache / Reflect**: client-side sync protocol, very different mental model.

**See also:**
- `ELECTRIC-SQL-MIGRATION.md` — Postgres + true cursor-based resumable sync
- `SYNC-ENGINE-DESIGN.md` — stay on PB, build the sync layer ourselves

---

## What we gain / lose (original)

**Gain:**
- More reliable realtime transport (WebSocket vs SSE, no 5-min idle disconnect).
- Proper joins and views — Postgres can collapse our hand-rolled multi-collection fetches.
- BI tooling (Metabase, Grafana, DBeaver, plain `psql`) just works.
- Standard backups (`pg_dump`, `pgbackrest`, PITR) instead of "the SQLite file in a PVC".
- Future-proofing — more applications speak Postgres than PB.

**Lose:**
- PB's admin UI (Supabase Studio is similar but different).
- The "one binary" simplicity of PB.
- A few weeks of focused work.
