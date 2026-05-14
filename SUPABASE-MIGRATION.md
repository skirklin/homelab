# Supabase migration plan

Working document, drafted 2026-05-13. **Not a commitment** — captured here so
we can revisit when we have a separate reason to want Postgres (joins, views,
BI tooling, better backups) or if PocketBase's failure modes become more
painful than the migration cost.

The trigger for this exploration was repeated PocketBase realtime drop-outs on
mobile (SSE-based, no session resumption). That specific symptom is now
mitigated by `wpb.resync()` (focus/visibility-driven catch-up) at trivial
cost; the migration would be for *architectural* upgrades, not to fix a
breakage.

---

## Why Supabase (over the alternatives we considered)

- **Realtime quality**: Postgres logical-replication-backed change stream is
  sequence-numbered, survives reconnects with proper resume semantics. SSE/WAL
  via Phoenix Channels on WebSocket — qualitatively different from PB's bare
  SSE. This is the "transcript-like" property we want.
- **Auth bundled**: GoTrue (now `auth-server`) ships with the stack —
  email/password, OAuth (Google/Apple/GitHub), magic links, JWT issuance,
  Row-Level Security integration. Same paradigm as Firebase Auth.
- **Closest to current model**: We already lean on PB's "REST + collection
  rules + realtime subscriptions" mental model. Supabase is "REST/SQL +
  RLS + realtime subscriptions" — same shape, more powerful backend.
- **Operational reality**: Self-hostable. Stack is ~10 containers (Postgres,
  GoTrue, Realtime, Kong, Studio, PostgREST, Storage-API, ImgProxy, Edge
  Functions, Meta) — more pieces than PB's single binary, but each is
  independent and well-instrumented. Tolerable on the existing k3s cluster.

Alternatives considered:
- **CouchDB + PouchDB**: most "transcript-like" of any option (native
  `_changes` feed with sequence numbers, full offline replication via
  PouchDB). Higher migration cost — different query model, no joins,
  document-oriented. Worth revisiting only if we want offline-first as a
  first-class feature.
- **SurrealDB**: `LIVE SELECT` is first-class. Newer, less battle-tested
  than Postgres-based options. Different query language.
- **Convex**: reactive queries are the whole product. Excellent, but
  hosted-only (no self-host) — would be a step backward on our "own the
  infra" principle. Also another vendor surprise-bill risk.
- **Replicache / Reflect**: client-side sync protocol designed exactly for
  this. Very high migration cost (different mental model — server emits
  patches, client mutators). Overkill for our scale.

---

## Effort: ~2 weeks focused work

| Phase | Work | Days |
|---|---|---|
| 1 | Stand up Supabase self-hosted in k3s; pick names/ports/secrets | 1-2 |
| 2 | Schema migration: PB collections → Postgres tables + RLS policies | 2-3 |
| 3 | Write `packages/backend/src/supabase/*.ts` impls of each interface | 3-5 |
| 4 | New wpb realtime adapter on Supabase channels; queue layer stays | 1-2 |
| 5 | Port `services/api/` to `@supabase/supabase-js` admin client | 1 |
| 6 | Port sharing hooks (`infra/pocketbase/pb_hooks/sharing.pb.js`) to Edge Functions or Postgres triggers | 1 |
| 7 | Data migration script (PB → Supabase), idempotent like the FB→PB one | 1-2 |
| 8 | Parallel-run period + cutover + fix surprises | 2-3 |
| **Total** | | **~12-18 days** |

---

## What changes, what doesn't

**Unchanged (100% reuse):**

- All app code in `apps/*` — they only know about the `@homelab/backend`
  interfaces (`ShoppingBackend`, `RecipesBackend`, …). The interfaces stay.
- The MCP server (`services/api/src/mcp.ts`). It hits Hono routes, not PB
  directly.
- Migration scripts as a *pattern* — the FB→PB one in
  `services/scripts/migrate-firebase.ts` is the model for a PB→Supabase one.

**Rewritten:**

- `packages/backend/src/pocketbase/*.ts` → `packages/backend/src/supabase/*.ts`
  (~5 files, mostly mechanical translation of PB SDK calls to
  `@supabase/supabase-js` calls).
- The realtime portion of `packages/backend/src/wrapped-pb/index.ts`.
  Queue/composeView logic stays; the `ensureRealSubscription` path moves
  from `pb.collection(name).subscribe("*", cb)` to
  `supabase.channel(name).on('postgres_changes', {filter, schema, table}, cb)`.
- `services/api/src/lib/pb.ts` → `services/api/src/lib/supabase.ts` (admin
  client using the service-role key).
- Hooks in `infra/pocketbase/pb_hooks/` (sharing, invite redemption) move
  to Supabase Edge Functions (Deno runtime) or Postgres triggers.

**Re-expressed (same intent, different syntax):**

- Access control: PB collection rules (1-line filter strings referencing
  `@request.auth.id` and `parent.owners.id`) become Postgres RLS policies.
  Example, for `shopping_items`:

  ```sql
  -- PB rule today:
  --   @request.auth.id != "" && @request.auth.id ?= list.owners.id
  --
  -- Supabase RLS:
  CREATE POLICY "owners can see items"
    ON shopping_items FOR SELECT
    USING (
      EXISTS (
        SELECT 1 FROM list_owners
        WHERE list_owners.list_id = shopping_items.list_id
          AND list_owners.user_id = auth.uid()
      )
    );
  ```

  More verbose, but compositional and SQL-y. The shared-many-to-many
  ownership pattern stays.

---

## Auth migration

GoTrue stores password hashes as bcrypt; PB uses Argon2id. We can't transfer
hashes directly. Options:

1. **Force password reset on cutover** (recommended). Users receive a
   "we upgraded; please reset" email. Simplest, no security compromises.
2. **Side-by-side login**: keep PB auth running on the old subdomain for a
   week; new users sign up on Supabase; users who hit the new domain are
   prompted to re-auth and get migrated. More complex; no real benefit.
3. **Custom rehash on first login**: intercept Supabase's sign-in, compare
   against PB's Argon2id hash, then store as bcrypt. Possible via Edge
   Function but requires touching GoTrue internals. Not worth it for our
   ~10 users.

OAuth identities migrate cleanly — same provider, just a new OAuth client
configured server-side. The user's `sub` claim is what matters.

---

## Risks and how we'd mitigate

| Risk | Mitigation |
|---|---|
| Supabase self-hosted has ~10 containers vs PB's one | Helm chart exists; add to k3s with a single `kubectl apply`. Monitor each with Gatus checks (same pattern as today's PB check). |
| RLS policies are stricter than PB rules — some checks awkward | Spend Phase 2 (schema) writing every policy *before* touching app code. Catches surprises early. |
| Realtime channel scope is per-table-with-filter, not per-collection | The wpb interface stays. Implementation changes; subscribers unaware. |
| Data migration loses information (we saw this with FB→PB, e.g., recipe_events) | Reuse the lessons: build a recipe-id map up front, pass through timestamps, test on a dry-run dump. The `services/scripts/scan-fb-id-orphans.py` style audit is reusable. |
| Storage migration (images, recipe photos) | Use Supabase Storage; migrate files in a side script. Currently we don't store files in PB (all images are external URLs), so this is mostly a no-op. |
| Operational learning curve | Supabase Studio replaces PB Admin UI — different but more powerful. Postgres operations (backups, vacuum, etc.) are standard, well-documented. |

---

## What we'd gain

- **Reliable realtime** without focus-based hacks (Postgres replication is
  sequence-numbered and resumable).
- **Proper joins and views** — currently we hand-roll multi-collection
  fetches (e.g., recipe → box → owners). Postgres views collapse these.
- **BI tooling**: any Postgres-aware tool (Metabase, Grafana, DBeaver, plain
  `psql`) just works. PB's data export is JSON dumps.
- **Standard backups**: `pg_dump`, `pgbackrest`, PITR. Today's PB backup is
  the SQLite file in a PVC.
- **Future-proofing**: more applications speak Postgres than speak PB. If we
  ever want a Go/Python/Rust service to read homelab data, Postgres makes
  that trivial.

## What we'd lose

- **PB's admin UI** for casual inspection. Supabase Studio is similar but
  different.
- **The "one binary" simplicity** of PB. The trade for the realtime upgrade.
- **A few weeks** of focused work. Real, not free.

---

## Decision triggers (when to actually do this)

We've decided to defer this in favor of the resync mitigation for now. We'd
revisit if any of these become true:

1. The resync fix doesn't actually paper over the realtime drops in practice
   (multiple confirmed failures *after* the resync ships).
2. We hit a feature wall that wants real joins/views (e.g., cross-app
   analytics, household-shared dashboards across users).
3. PB upstream releases a backwards-incompatible change that's painful to
   absorb.
4. We want native BI tooling on the homelab data.
5. We grow past ~5 users and need finer-grained access control than PB
   collection rules can express cleanly.

Until then: stay on PB.
