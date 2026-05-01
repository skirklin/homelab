# Optimistic writes plan

Make writes feel instant by mirroring Firestore's mutation-queue + server-snapshot model on top of PocketBase. Both UI writes and PB subscription events feed a single composed view: `view = apply(serverSnapshot, mutationQueue)`. Convergence and rollback fall out of the model — no pre-image bookkeeping, no ordering races, no flicker.

## Goal & non-goals

**Goal.** UI reflects the user's action within a frame, regardless of network latency. Server is authoritative; the local view converges on real state via the existing subscription stream.

**Non-goals.**
- Offline writes. Reads-only offline is the design (S44). Writes attempted offline fail immediately. (The persisted mutation queue described below is for surviving reloads of *online* writes mid-flight, not for queueing edits during extended offline periods.)
- Conflict resolution beyond last-write-wins.

## Foundation: client-supplied IDs

PocketBase `create()` accepts a client-supplied `id` if it matches `[a-z0-9]{15}`. Generating IDs locally lets us:
- Return the ID synchronously (no `await` for create RTT).
- Skip temp-ID remap — the live event carries the same ID, merges by id.
- Compute derived fields (e.g. task `path`) before the create call.

Util at `packages/backend/src/cache/ids.ts` generates 15-char strings via `crypto.getRandomValues`. Collision odds at our scale are negligible.

## The mutation-queue model

Wrap PocketBase. The wrapper owns per-collection state:

```
Map<collection, Map<id, { server: RawRecord | null, queue: Mutation[] }>>
```

A `Mutation` is one of:
- `Set(record)` — full record (emitted by optimistic creates with synthesized fields)
- `Update(patch)` — partial field merge
- `Delete`

**View.** Per-id, `view(id) = apply(server, queue)` where `apply` folds the queue over the server snapshot:
- `Set(r)` → `r`
- `Update(p)` → `prev ? {...prev, ...p} : prev`
- `Delete` → `null`

The collection view is `[...map.values()].map(view).filter(r => r !== null)`.

**UI write.** Push a `Mutation` onto the id's queue, emit to subscribers, dispatch to PB in the background.

**PB ack.** Remove the matching mutation from the queue. (No emit needed in isolation — the server event that arrives in parallel updates `server` and triggers an emit.)

**PB reject.** Remove the matching mutation from the queue, emit. The view reverts naturally because there's no longer anything overlaying the server snapshot.

**PB server event.** Update `server`, emit. If the queue is non-empty, the view still reflects the pending mutations on top — the user's optimistic edit doesn't get clobbered by a server snapshot that hasn't acked it yet.

What this collapses by construction:
- **Update-update races / flicker.** The queue maintains order. A second update lands as a second mutation; both are visible in the view in sequence; both drain in order as acks arrive. Server events updating `server` can't undo pending mutations because they're applied on top.
- **Partial updates needing the full prior record.** Mutations are stored as patches; composition happens at view-compose time against whatever the latest `server` is.
- **Recovery on reject.** Drop the mutation. The server snapshot is the baseline, always. No pre-image bookkeeping.
- **Multi-record ops** (shopping's `clearCheckedItems`, etc.). Each PB call is an independent mutation in its respective id's queue. Each acks/rejects independently.

## Persistence

The cache layer already persists reads to IndexedDB ([packages/backend/src/cache/storage.ts](packages/backend/src/cache/storage.ts)); Firestore's `enableIndexedDbPersistence()` bundles persisted reads and persisted mutations as one feature, so for parity the mutation queue persists too.

A single IndexedDB object store keyed by `mutationId` holds pending mutations:

```
{ id, collection, recordId, kind: 'set'|'update'|'delete', payload, createdAt }
```

- **On dispatch:** write to IDB before firing to PB (so a crash between dispatch and ack still gives us a record to replay).
- **On ack:** delete from IDB.
- **On reject:** delete from IDB. The wrapper has already dropped it from the in-memory queue and emitted.
- **On wrapper init:** read all pending mutations, push them into the in-memory queues in order, and re-fire to PB.

Replay is safe-by-design because of the foundational choices:
- **Creates** carry client-supplied IDs → re-firing is idempotent on PB. A 409-style "id exists" on replay is treated as success (the prior session's network call landed before crash).
- **Updates** are last-write-wins patches → safe to retry.
- **Deletes** → 404 on replay means "already deleted" → success.

**Multi-tab.** Two tabs sharing one origin can both replay on init. Idempotent replay means double-fire is safe in correctness terms but wasteful. Use a `BroadcastChannel` leader-elect so only one tab owns the queue at a time. (If a leader tab closes, another picks up the queue.)

**Schema migrations.** If the mutation shape ever changes, the wrapper's init logic discards entries it doesn't recognize. Cheap and safe — at worst, a never-replayed mutation is dropped. Acceptable because mutations are short-lived (typically <500ms on healthy network).

## Architecture

```
UI
 ↕
Domain backends (ShoppingBackend, etc.) — adapter logic, mappers, multi-op orchestration
 ↕
Wrapped PB — mutation queues, server snapshots, view composition, recovery
 ↕
Real PB SDK
```

Per-domain decorators in `packages/backend/src/cache/` keep their existing jobs:
- Translating raw PB records ↔ domain types via the existing `pocketbase/*.ts` mappers.
- Gluing per-collection event streams into multi-callback subscription handler shapes (e.g. shopping's `onList` / `onItems` / `onHistory` / `onTrips`).
- Offline read cache (`cachedRead`) for non-subscription reads.

The optimistic logic doesn't appear in the per-domain decorators — it's all in the wrapped PB.

## Prerequisites: eliminate read-then-write at the adapter level

Two shopping methods do network read-then-write today. Both can be refactored to take already-loaded data from the caller (the UI's subscription delivers it), which eliminates the only adapter call sites that would otherwise need query-time local filtering against optimistic state.

- [shopping.ts:115-125](packages/backend/src/pocketbase/shopping.ts#L115-L125): `addItem` reads `shopping_history` to suggest a category. Refactor: caller passes `categoryId` (UI does the lookup against its own subscribed `onHistory` data). Adapter becomes dumb.
- [shopping.ts:165-188](packages/backend/src/pocketbase/shopping.ts#L165-L188): `updateItemCategory` reads the item to find its `listId` for the history upsert. Refactor: caller passes `listId` — UI knows it because it's rendering the item in a specific list.

Other apparent "reads" inside adapters (upkeep's `addTask` parent path, `deleteTask` descendants, `moveTask` paths) are local-map lookups, not network queries — they fall out for free in the optimistic model because the UI's subscription has the relevant records loaded.

Do these refactors before the wrapper work. Without them, the wrapper would need a query-time filter engine; with them, it doesn't.

## Subscription-predicate evaluation

PB subscriptions can be filtered (`{filter: 'list = "abc"'}`); the wrapper must evaluate that filter against records before emitting, otherwise an optimistic write to one shopping list would fire on subscriptions for other lists. This is unavoidable but cheap.

Subscriptions accept a JS predicate function alongside the PB filter string:

```ts
wrapped.subscribe("shopping_items", {
  pb: pb.filter("list = {:listId}", { listId }),
  local: (r) => r.list === listId,
}, cb);
```

The wrapper uses `pb` for the network subscription and `local` for fanning optimistic mutations to the right subscribers. v1 writes these by hand at each adapter call site. v2 (if it earns its weight) introduces a structured filter representation that compiles to both forms.

## Adapter changes

Every PB adapter `create*` signature gains an optional `id` parameter:

| File | Method | Change |
|---|---|---|
| [pocketbase/shopping.ts:74](packages/backend/src/pocketbase/shopping.ts#L74) | `createList` | accept `id` |
| [pocketbase/shopping.ts:106](packages/backend/src/pocketbase/shopping.ts#L106) | `addItem` | accept `id`; signature also takes `categoryId` from caller (see Prerequisites) |
| [pocketbase/shopping.ts:165](packages/backend/src/pocketbase/shopping.ts#L165) | `updateItemCategory` | signature also takes `listId` from caller (see Prerequisites) |
| [pocketbase/upkeep.ts:61](packages/backend/src/pocketbase/upkeep.ts#L61) | `createList` | accept `id` |
| [pocketbase/upkeep.ts:85](packages/backend/src/pocketbase/upkeep.ts#L85) | `addTask` | **see special case** |
| [pocketbase/recipes.ts:85](packages/backend/src/pocketbase/recipes.ts#L85) | `createBox` | accept `id` |
| [pocketbase/recipes.ts:155](packages/backend/src/pocketbase/recipes.ts#L155) | `addRecipe` | accept `id` |
| [pocketbase/life.ts:50](packages/backend/src/pocketbase/life.ts#L50) | `createLog` | accept `id` |
| [pocketbase/life.ts:72](packages/backend/src/pocketbase/life.ts#L72) | `addEntry` variants | accept `id` |
| [pocketbase/travel.ts:82](packages/backend/src/pocketbase/travel.ts#L82) | `createLog` | accept `id` |
| [pocketbase/travel.ts:91](packages/backend/src/pocketbase/travel.ts#L91) | `addTrip` | accept `id` |
| [pocketbase/travel.ts:108](packages/backend/src/pocketbase/travel.ts#L108) | `addActivity` | accept `id` |
| [pocketbase/travel.ts:121](packages/backend/src/pocketbase/travel.ts#L121) | `addItinerary` | accept `id` |
| [pocketbase/travel.ts:145](packages/backend/src/pocketbase/travel.ts#L145) | `createProposal` | accept `id` |

Interface signatures in `packages/backend/src/interfaces/*.ts` get the same optional param. Existing callers keep working — PB still mints one if absent.

### Special case: `upkeep.addTask`

Today this is 3 RTTs:

```
create(parentless task) → record.id
getOne(parentId)        → parent.path
update(record.id, {path: parent.path + "/" + record.id})
```

With client-supplied IDs *and* the parent's path already in cache, collapses to one:

```
const id = newId();
const path = parentId ? parentMap.get(parentId).path + "/" + id : id;
create({id, path, ...})
```

Net speedup even before optimistic UI. If the parent isn't loaded (deep link), fall back to today's 3-RTT path.

## Fall-back-to-non-optimistic cases

- **File uploads.** PB returns server-generated filenames; we can't synthesize them. Whatever paths involve uploads stay passthrough.
- **Server-side hooks** (e.g. invite redemption). Optimistic record won't reflect post-hook state; server event corrects it. Brief flicker on those specific writes — acceptable.
- **Updates on records we've never seen.** `Update(patch)` against a `null` server snapshot is a no-op locally; the network call still happens. Edge case; rare.

PB `expand` is not used anywhere in the frontend (verified by grep across apps and packages); the wrapper doesn't need to handle it.

## Error UX

Match Firestore: every wrapper write returns a `Promise<id>` that resolves on server ack and rejects on failure. The optimistic local update fires *synchronously* before the promise resolves, so the UI updates within a frame regardless of whether the caller awaits.

```ts
const id = await backend.addItem(...);  // optimistic update fired synchronously; await blocks for ack
```

Call sites that care handle errors locally with `try/catch`. Call sites that don't care fire-and-forget; the rejection becomes an unhandled promise rejection.

A global `unhandledrejection` listener in the app shell catches un-awaited rejections from the wrapper (tagged with an `op` field for context) and shows a generic toast. This is a safety net, not the primary mechanism — call sites that want custom messaging should `await` and toast themselves.

No auto-retry — hard rejections won't pass on retry; transient blips are handled by the user re-pressing.

## Phasing

1. **Shopping refactors (Prerequisites section)** — push category lookup and listId resolution up to the UI. Ships independently; no wrapper dependency.
2. **Wrapped PB infrastructure + shopping prototype.** Build the wrapper (mutation queue, server snapshot, view composition, subscription with JS predicates). Wire shopping's `subscribeToList` through it. End-to-end: throttle network in Playwright, fire writes, assert UI within a frame.
3. **Upkeep**, including `addTask` path-collapse and the optimistic-aware delete-with-descendants flow.
4. **Travel.** Multi-collection sessions (trips, activities, itineraries).
5. **Recipes, life, user.** Mostly straightforward after the above.

Each phase ships independently. Phase 1 carries the bulk of the perceived-latency win.

## Testing

- Unit tests on the mutation-queue model in isolation: stub PB, assert view composition for {Set, Update, Delete} ordered with server events arriving before/after/between mutations. Assert reject drops the mutation and emits. Assert acks are matched to the right mutation in the queue.
- Unit tests on persistence: write mutations, simulate crash by re-instantiating wrapper from IDB, assert replay fires in order. Stub PB to return 409/404 on replay, assert treated as success.
- Playwright covers user-visible behavior: throttle network, fire write, assert UI within a frame, assert it survives the delayed network response.
- Playwright rejection test: stub a 4xx, assert revert + the global `unhandledrejection` toast fires when the call isn't awaited.
- Race test: fire two updates in quick succession, assert no flicker (view always shows latest pending).
- Reload-mid-flight test: fire a write, navigate before ack, return to the page, assert the write landed (replay from IDB).

## Open questions

None remaining at the design level; ready to start phase 1.

## Future improvement: JSON list/map fields → relations / own collections

The optimistic-writes work surfaced several JSON fields that act as one-to-many relationships modeled in-line. Today they require read-then-write merges (mitigated by the wpb cache, but still semantically awkward). Migrating them to first-class PB relations or their own collections would enable atomic upserts via PB's `+=`/`-=` operators or unique-constraint-backed inserts, removing the need for the read entirely and giving us referential integrity.

Candidates:

| Today | Should be | Win |
|---|---|---|
| `users.recipe_boxes` (json: `string[]`) | multi-relation field on users → `recipe_boxes` | atomic `+=`/`-=` for createBox / subscribeToBox / unsubscribeFromBox; PB enforces existence; cascade on box delete. Existing test "handles stale box reference after box deletion" needs review (cascade may auto-clean what it tests for). |
| `users.fcm_tokens` (json: `string[]`) | own collection `fcm_tokens(user, token, created)` with unique (user, token) | atomic insert/delete per token; no parent read; clean delete-by-token via filter. |
| `users.{shopping,household,travel}_slugs` (json: `Record<slug, resourceId>`) | own collection `user_slugs(user, namespace, slug, resource)` with unique (user, namespace, slug) | setSlug becomes a single insert (or upsert via deterministic id); removeSlug a single delete; renameSlug a single update. Eliminates the ~2-RTT read-merge-write pattern that hits every list create / join / rename across all three apps. |
| `users.life_log_id` (json: single string) | single relation field on users → `life_logs` | minor; mostly cleanliness. |

**Scope of any of these.** PB schema migration + backfill in one transaction; rewrite the affected adapter methods (and their cache decorators); update the PB JS hook for invite redemption (`infra/pocketbase/pb_hooks/sharing.pb.js`) where it mutates these fields; update API service routes that read them (`services/api/src/routes/data.ts`); update e2e tests that set these fields directly via raw PB; update any frontend code that reads them from `getProfile` (`apps/home/app/src/shared/Timeline.tsx` reads `household_slugs`).

**Why not done now.** The cache-aware reads in the affected adapters already eliminate the latency cost in the common case (when the user record is subscribed, which is whenever the relevant UI is visible). The migrations buy cleaner data modeling and atomic semantics, not much measurable perf. Worth doing as a deliberate cleanup pass when the data-model debt warrants it, not as part of the optimistic-writes effort.

The slugs migration is the highest ROI of the four — every list create/join/rename across shopping/upkeep/travel hits it, and the namespace+slug composite key fits a relational model cleanly. If/when we do this, it's the one to start with.
