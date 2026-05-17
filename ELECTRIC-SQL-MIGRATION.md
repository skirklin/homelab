# ElectricSQL migration plan — NOT PURSUED

> **Status: not pursued 2026-05-17.** Kept for reference because it's
> the only one of the three options written up that *would* close the
> cursor gap with an existing tool. If we ever revisit the realtime
> question and decide the Supabase tradeoff was wrong, this is the
> next thing to read.
>
> Why we didn't pursue: we abandoned the Supabase migration when it
> turned out not to justify the work (see `SUPABASE-MIGRATION.md`),
> and chose to either stay on plain PocketBase or build the missing
> sync layer on top of PB (`SYNC-ENGINE-DESIGN.md`). Electric had a
> higher migration cost than either.

---

Working document, drafted 2026-05-13. Peer to `SUPABASE-MIGRATION.md` —
both describe ways out of PocketBase, with different trade-offs.

**Why this exists**: Supabase fixes the realtime *transport* (WebSocket vs
SSE) but not the *protocol*. The Supabase client SDK does not expose a
per-subscription cursor — on reconnect you re-subscribe and start from
"live now", then separately re-fetch to catch up. That's structurally
identical to `wpb.resync()`; better transport, same protocol gap.

ElectricSQL is the option that actually closes that gap.

---

## What ElectricSQL is

A sync engine between Postgres and a local store on each client:

```
                  ┌─────────────┐
   Postgres ────► │  Electric   │ ───► WebSocket ───►  clients
   (logical          (sync         (with proper       (local SQLite
    replication)      server)       resume tokens)     or PGlite)
                  └─────────────┘
```

- **Server**: Postgres, plus the Electric sync server (one container,
  reads the WAL, manages client shapes).
- **Client**: a TypeScript library that maintains local SQLite (via
  `wa-sqlite` in the browser) or PGlite (Postgres-in-WASM). Reads happen
  against the local store; the sync layer keeps it caught up.
- **Shapes**: each client declares a shape (e.g., `from shopping_items
  where list_id = 'L1'`). Electric tracks the client's position in each
  shape's change stream and replays exactly the missed events on
  reconnect. **This is the primitive we've been missing.**
- **Writes**: the current model has writes go through your own API to
  Postgres. Electric picks up the change via replication and pushes it
  to the relevant shapes. (Earlier "Electric Classic" did two-way CRDT
  sync; the current design is read-path-only, which is actually a
  simpler fit for our wpb-style optimistic-queue model.)

---

## Why this over Supabase

- **Proper cursor-based resume.** The whole reason we'd migrate at all.
  On reconnect, Electric delivers exactly the missed events — no
  full-filter refetch, no `resync()`, no "did I miss something" guesswork.
- **Local SQLite as the cache.** Reads execute SQL against the local DB.
  Offline reads are real reads, not the "queue overlay" composition wpb
  does. Joins, aggregates, ORDER BY — all natively local.
- **The protocol semantics are what we wanted.** Sequence-numbered,
  resumable, append-only stream of changes — the "transcript" property.

vs Supabase: better matches the requirement. vs CouchDB: keeps Postgres
benefits and matches the multi-user / row-level access model.

## Why not Electric (the honest risks)

- **Younger project.** Active development, hit 1.0 recently, but doesn't
  have Postgres-grade decades of operational scars. We'd be early.
- **Auth is bring-your-own.** No bundled GoTrue. Either run our own
  (a separate GoTrue container) or use a thin custom token system. More
  pieces to operate than Supabase's "everything in one stack."
- **Client mental model shifts more than Supabase would.** With Supabase
  the @homelab/backend adapters translate PB SDK calls to Supabase SDK
  calls — mechanical. With Electric the *reads* shift to "query the local
  SQLite via Electric's typed client" while writes still go to a separate
  REST/RPC layer. Two-API surface. Less ugly than it sounds (the
  abstractions help) but more conceptual movement.
- **PGlite (Postgres-in-WASM) or wa-sqlite in the browser** is a real
  dependency. Bundle size goes up; first-load is slower. We need to
  measure on a slow phone before committing.

---

## Effort: ~3-4 weeks focused work

| Phase | Work | Days |
|---|---|---|
| 1 | Stand up Postgres + Electric sync server in k3s; auth (GoTrue or custom) | 2-3 |
| 2 | Schema design (Postgres tables, RLS-equivalent shape rules) | 2-3 |
| 3 | Replace `packages/backend/src/pocketbase/*.ts` with Electric-backed impls | 5-7 |
| 4 | Write path: a thin Hono-based API for mutations (replaces PB's REST surface) | 3-4 |
| 5 | Replace wpb's transport with Electric's shape subscriptions | 3-5 |
| 6 | Port the api service + MCP tools to talk to the new write API | 2-3 |
| 7 | Sharing/invite logic → Postgres functions or the new API service | 1-2 |
| 8 | Data migration script (PB → Postgres) | 1-2 |
| 9 | Parallel-run + cutover + bug hunt | 3-5 |
| **Total** | | **~22-34 days** |

Slower than Supabase (~12-18 days) because the client mental model is
bigger, but the *payoff* is qualitatively different — proper sync
semantics, not just better transport.

---

## What changes vs what we have

**Unchanged:**

- `apps/*` — they read through `@homelab/backend` interfaces. The shape
  of those interfaces stays.
- The MCP server.
- Migration-style scripts as a pattern.

**Rewritten:**

- `packages/backend/src/pocketbase/*.ts` → new Electric-backed impls.
  Reads become "query local Electric-synced SQLite"; writes become
  "POST to a thin write API."
- `wpb` largely goes away. The optimistic queue + composeView lives on
  for offline writes, but the realtime read path becomes Electric's
  shape subscriptions. The "synthesize create/update/delete from a
  composed view" plumbing is no longer ours to maintain.
- `services/api/` grows a write-API surface (currently most data writes
  go directly through PB; with Electric, writes need a server endpoint).

**Re-expressed:**

- Access control: PB collection rules → Electric shape definitions +
  server-side checks in the write API. Shape rules answer "what rows
  sync to this client"; the write API answers "is this client allowed
  to write this row."

---

## Auth path

Electric doesn't bundle auth. Options, in order of effort:

1. **Self-hosted GoTrue** (Supabase's auth-server, runs standalone).
   Standard, well-documented, JWT-based. Adds one container to the
   stack.
2. **Reuse PocketBase's `_superusers` + a custom token endpoint** as a
   bridge during migration. Simpler short-term; not the long-term
   answer.
3. **Custom JWT issuance from the api service.** Most control, most
   code we maintain.

(1) is what we'd land on.

---

## Risks beyond the obvious

| Risk | Mitigation |
|---|---|
| Electric upstream changes break us | Pin versions; treat upgrades as scheduled work, not background. Same discipline as any infra dep. |
| In-browser SQLite (`wa-sqlite` or PGlite) is slow on low-end phones | Measure on Angela's phone class before committing. If bundle size or first-paint regresses materially, this is a no-go. |
| Schema migrations need to coordinate across Postgres and the synced clients | Electric handles this via shape versioning, but it's a new discipline we'd learn. |
| Multi-write conflict semantics | Electric's current model uses Postgres as the source of truth, so conflicts resolve at the write API. No CRDT magic to debug. Same model as today, structurally. |
| Bus factor on the sync infra | Less than rolling our own (next doc), more than Supabase. Project is open-source with public roadmap. |

---

## What we'd gain

- The actual primitive we want: client-tracked cursor with server-driven
  delta replay on reconnect. Indistinguishable from Firestore listeners
  in observable behavior.
- Postgres on the server — joins, views, BI, standard backups.
- Local SQLite on the client — real SQL on offline data, faster reads
  than IndexedDB indices.
- Smaller wire footprint than the resync approach.

## What we'd lose

- A few weeks of focused engineering.
- The "PocketBase is one binary" simplicity (Electric stack is ~4-5
  containers: Postgres + Electric + auth + ingest write-API + reverse
  proxy).
- Maturity buffer (Electric is younger than Postgres or CouchDB).

---

## Decision triggers

We'd pick this over Supabase if:

1. The "proper resume" property is a real requirement, not a nice-to-have.
2. We're willing to invest 1-2 extra weeks for a qualitatively better
   sync story.
3. We accept higher upstream-dependency risk in exchange.

We'd pick Supabase over this if:

1. `resync()`-style full-refetch on reconnect is acceptable for our data
   sizes (it probably is — see numbers in `SUPABASE-MIGRATION.md`).
2. We want the most mature, well-trodden Postgres-backed stack.
3. We value bundled auth + Studio + edge functions enough to weigh against
   the protocol gap.

We'd pick rolling our own (see `SYNC-ENGINE-DESIGN.md`) if:

1. We don't want to migrate the DB at all.
2. We're comfortable owning a custom sync layer.
3. The events-table-on-PB design has acceptable performance at our scale.
