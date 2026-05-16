# Custom sync engine on top of PocketBase

Design sketch, drafted 2026-05-13. Third option alongside
`SUPABASE-MIGRATION.md` and `ELECTRIC-SQL-MIGRATION.md`. The premise: we
don't migrate the DB — we add the missing layer (cursor-based resumable
sync) directly to the stack we have.

The principle: **PocketBase's access model is right for our app; only the
realtime channel is wrong.** Fix that one thing instead of moving the
whole house.

---

## What we're building (one paragraph)

An append-only `sync_events` table in PB, populated by JS hooks on every
write to every user-facing collection. A new HTTP endpoint
(`GET /api/sync/since?cursor=N&filter=...`) that long-polls and returns
events with `seq > N`. Clients track their cursor per subscription, store
it in IndexedDB, and resume from there on reconnect. SSE goes away;
long-polling replaces it for both initial load and live updates.

That's the whole idea. Everything below is the design detail.

---

## Architecture

```
                                            ┌── /api/sync/full
                                            │     (initial snapshot + cursor)
                                            │
[ Browser ] ── wpb-sync transport ────► ┌───┴─────────┐
   │                                    │ Hono routes │
   │     cursor in IndexedDB            │ (services/  │
   │     subscription per logical view  │  api/)      │
   │                                    └───┬─────────┘
   │  initial: GET /api/sync/full         ▲ │
   │  live:    GET /api/sync/since?       │ │
   │             cursor=N&filter=...      │ │
   │           (long-poll up to 30s)      │ ▼
   │                                    ┌─────────────┐
   ▼  writes still go via PB SDK ─────► │ PocketBase  │
   wpb.collection().create() etc.       │             │
                                        │  + sync_    │
                                        │    events   │
                                        │    table    │
                                        │             │
                                        │  + JS hooks │
                                        │    on every │
                                        │    write    │
                                        └─────────────┘
```

Three components:

1. **`sync_events` table + write hooks** (PocketBase side).
2. **`/api/sync/{full,since}` endpoints** (Hono / api service).
3. **`wpb-sync` transport** (client side, replaces the SSE path in wpb).

---

## Schema

```sql
CREATE TABLE sync_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  collection  TEXT    NOT NULL,
  record_id   TEXT    NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('create','update','delete')),
  payload     TEXT,            -- JSON: full record state after op (NULL for delete)
  actor_id    TEXT,            -- user/system that triggered the change
  parent      TEXT,            -- denormalized parent ref (e.g. list_id) — see "Access" below
  created     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sync_events_collection_seq ON sync_events (collection, seq);
CREATE INDEX idx_sync_events_parent ON sync_events (collection, parent);
```

Why each column:

- **`seq` AUTOINCREMENT**: the cursor. Server-managed, monotonic, simple.
  SQLite serializability gives us in-order writes.
- **Full `payload`, not diffs**: simpler. Wire cost is negligible at our
  scale. A diff format would save bytes on big records but complicate
  the client's apply logic.
- **`parent`**: denormalized so the access check on `/api/sync/since`
  doesn't have to JOIN to the live record for every event. The hook
  reads e.g. `shopping_items.list` and writes that into `parent`.
  Trade-off: stale if the parent record itself is updated. For our
  rules (where `parent` is the immutable ownership root) this is fine.
- **`actor_id`**: useful for "don't re-emit my own writes back to me"
  optimization and for auditing.

Retention: a cron deletes `sync_events` older than 7 days. Clients gone
longer than that fall back to a full snapshot (`/api/sync/full`). This is
a bounded-storage commitment; tunable.

---

## PocketBase hooks

For every user-facing collection (currently 14: shopping_lists,
shopping_items, shopping_history, shopping_trips, recipe_boxes, recipes,
recipe_events, life_logs, life_events, task_lists, tasks, task_events,
travel_trips, travel_activities, travel_itineraries — auth/system
collections excluded), wire an `OnRecordAfter{Create,Update,Delete}` hook
that inserts the corresponding `sync_events` row.

PocketBase exposes these via JS hooks in `infra/pocketbase/pb_hooks/`.
A single hook file (`sync.pb.js`) can register all 42 handlers in a loop
keyed off a small `COLLECTIONS_TO_SYNC` config.

Failure handling: if the hook fails (e.g., the JSON serialization
explodes on a malformed payload), log it and continue. The original write
still happens; we just have a missing event. Clients fall back to a full
resync — degraded but correct.

Atomicity: PB hooks fire inside the same transaction as the parent write,
so a hook failure rolls back the original write. We don't want that —
better to lose an event than block a user write. The hook should catch
its own errors and log instead of throwing.

---

## API endpoints

### `GET /api/sync/full?collection=X&filter=...`

Initial snapshot. Returns:

```jsonc
{
  "records": [ /* current records matching filter */ ],
  "cursor": 12345  // max(seq) at this moment
}
```

Client uses this on first subscribe (or after retention-window
fall-back). Implementation:

1. Take a snapshot of `max(seq)` from `sync_events`.
2. Query the parent collection with the filter, applying the user's PB
   access rules (we reuse PB's `pb.collection(...).getFullList()` so rule
   evaluation is the same as today).
3. Return both. The cursor is taken *before* the query so we don't miss
   events that arrive during the query — the client will pick them up
   on the next `since` call.

### `GET /api/sync/since?cursor=N&filter=...`

Long-poll for events. Behavior:

- Compute the same filter against `sync_events` joined to the parent
  collection (or via the denormalized `parent` column).
- If matching events with `seq > N` exist: return them immediately.
- Else: hold the connection for up to 30 seconds. If new events arrive
  during the wait, return them. Otherwise return `{events: [], cursor: N}`.

Server uses an in-memory notify channel (per-collection condition
variable) that hook handlers signal on every insert. Long-pollers
suspend until either notified or timed out.

Response shape:

```jsonc
{
  "events": [
    {
      "seq": 12346,
      "collection": "shopping_items",
      "record_id": "abc123",
      "op": "update",
      "payload": { /* record state */ },
      "actor_id": "scott_uid"
    }
  ],
  "cursor": 12350  // max seq in this batch
}
```

### Access control

This is the design's hardest decision. Three approaches:

**A. Look up at fetch time (recommended).** For each candidate event,
join to the parent record and evaluate the collection's view rule using
PB's `pb.collection(col).viewRule` machinery. Simple and accurate; cost
is one rule eval per event in the response. For our access rules (mostly
"is the user in `list.owners`"), this is cheap.

**B. Denormalize allowed-viewer set into the event row.** The hook
computes "who can see this event right now" and stores a JSON array of
user IDs. Fast fetch (just `WHERE actor_user IN (allowed_viewers)`), but
stale if access changes (e.g., user removed from a list after the event
was written). Would need to re-evaluate on access changes.

**C. One sync_events table per parent collection.** Reuses PB's
collection rules directly. Most native; lots of duplication (14 tables,
14 routes).

We'd ship A. Cost analysis: at our scale, the events endpoint handles a
few dozen events per long-poll response, and each rule eval is
microseconds. If a collection ever gets chatty enough that this is a
bottleneck, B is the escape hatch.

---

## Client integration

The wpb internals shift but the public interface stays. Replace
`ensureRealSubscription` (which calls `pb.collection(c).subscribe("*")`)
with the new transport:

```typescript
async function ensureSubscription(collection: string, filter: string) {
  // 1. Find the current cursor for this (collection, filter) tuple.
  const stored = await idbGet(`sync:cursor:${collection}:${filter}`);
  let cursor = stored;

  // 2. First-time: fetch a full snapshot, save cursor.
  if (cursor == null) {
    const snap = await fetch(`/api/sync/full?collection=${collection}&filter=${encodeURIComponent(filter)}`).then(r => r.json());
    cursor = snap.cursor;
    await idbSet(`sync:cursor:${collection}:${filter}`, cursor);
    for (const r of snap.records) queue.applyServer(collection, r.id, r);
    // synthesize "create" notifications to subscribers
  }

  // 3. Long-poll loop. Each iteration advances cursor.
  while (subscriptionAlive) {
    const resp = await fetch(
      `/api/sync/since?cursor=${cursor}&filter=${encodeURIComponent(filter)}`,
      { signal: abortSignal },
    ).then(r => r.json());

    for (const evt of resp.events) applyEventLocally(evt);
    cursor = resp.cursor;
    await idbSet(`sync:cursor:${collection}:${filter}`, cursor);
  }
}
```

Key properties:

- Cursor persisted across reloads (in IndexedDB). Reload mid-session
  resumes from where we left off — no `resync()` ceremony.
- Reconnect = the next iteration of the long-poll loop. AbortController
  handles unsubscribe.
- No EventSource, no SSE, no PB realtime SDK. Just `fetch` + a loop.

Writes still go through wpb's existing `create/update/delete` —
unchanged, including the optimistic queue, persistence, and replay.
The hook on the server side writes the corresponding `sync_events` row,
which the client will eventually receive via the long-poll loop and
reconcile with its local queue.

---

## Why long-polling

- **Works through every proxy.** Just HTTP. No special middlebox config
  for SSE/WebSocket upgrade.
- **Mobile-resilient.** Each poll is a fresh HTTP request — token refresh,
  network switch, OS suspend/resume all "just work" via standard HTTP
  retry semantics.
- **Per-request auth.** No stale realtime session — every poll
  re-validates the JWT.
- **Backpressure-friendly.** Server controls batch size; client can't
  drown in a flood of events.
- **Trade-off**: ~200-1000ms first-event latency on a fresh poll vs
  <100ms on an established WebSocket. For grocery-list-add latency,
  irrelevant.

The other reasonable choice is WebSocket. We'd pick that if we wanted
bi-directional push or if first-event latency mattered. For our use
case, long-polling wins on operational simplicity.

---

## Effort: 2-3 weeks focused

| Phase | Work | Days |
|---|---|---|
| 1 | `sync_events` schema migration; cron for retention | 1 |
| 2 | `sync.pb.js` hooks on all 14 collections, with tests | 1-2 |
| 3 | `/api/sync/full` endpoint (snapshot + cursor) | 1 |
| 4 | `/api/sync/since` endpoint (long-poll + notify channel) | 2-3 |
| 5 | Access-control implementation (approach A: rule reuse) | 1-2 |
| 6 | New `wpb-sync` transport, slot it behind a feature flag | 3-4 |
| 7 | Migrate `subscribeToList` implementations across the backend impls | 2-3 |
| 8 | Parallel-run (SSE + sync) for confidence, then flip | 2-3 |
| 9 | Remove SSE path | 1 |
| **Total** | | **~14-20 days** |

Same order of magnitude as the Supabase migration, with the difference
that we end up with no migration — same PB, same data, same access
model. The sync layer is a strict addition.

---

## Risks

| Risk | Mitigation |
|---|---|
| Long-polls hold server connections; could starve PB's request pool | Cap concurrent long-polls per user; tune PB's connection settings. At our user count (~10) we have ~30x headroom. |
| Hook failure leaves an event unrecorded → client falls behind permanently | Cron job auditing PB's record count vs sync_events count, alerting on drift > N. Clients have a periodic full-resync fallback for safety. |
| Access changes (user removed from list) don't retroactively redact prior events | If a user is removed from a list, that's an access change; their next `/sync/since` evaluates the rule and won't return events they no longer can see. Past events on their device are stale local data, which is fine — the next live event for that record will be "delete from their view." |
| `sync_events` grows fast for chatty collections | Retention cron + index on `(collection, seq)`. If a collection is genuinely chatty (>10K events/day for our scale would be a lot) revisit retention or move to per-collection tables. |
| Custom sync engine = bus factor | Same engineering discipline as the wpb wrapper today — tests, comments, design docs (this one). We already own complex sync infra; we'd be replacing one in-house piece with a better in-house piece, not adding net complexity. |
| Long-polling debuggability | Add structured logs on every poll. Counter metrics for "long-polls open," "events delivered per poll," "cursor lag per client" — surface via existing Beszel/Gatus stack. |

---

## What we'd gain

- Proper cursor-based resume — the actual primitive we want.
- No DB migration. Same PB, same data, same access rules.
- One fewer running container than Supabase or Electric.
- Total protocol control — if we want to add presence, typing
  indicators, optimistic acks, etc. later, we own the wire format.

## What we'd lose

- An open-source sync engine maintained by other people. We own this.
- The chance to get Postgres benefits (joins, BI, ecosystem) "for free"
  as part of the same project.
- Some PB-internal scaling headroom — we're piling more load (the events
  table + long-polls) onto the existing PB instance.

---

## When to pick this

- The PB stack is otherwise serving us well.
- We don't want to move the DB.
- We're confident in our ability to maintain a custom sync engine for
  the lifetime of the homelab.
- Our scale stays modest (single-digit users, hundreds-of-records per
  collection, < few thousand events/day).

## When not to pick this

- We'd benefit from Postgres regardless of the sync question.
- We want to stop owning custom infrastructure and let other people
  worry about sync correctness.
- We anticipate growing past PB's comfort zone for other reasons
  (concurrent writers, large datasets, multi-region, etc.).
