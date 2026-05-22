/**
 * PBMirror — centralized PocketBase realtime subscription engine.
 *
 * One mirror, many consumers. Each consumer calls `watch(spec, onState)`;
 * the mirror handles cancel-before-resolve, ref-counted SSE coalescing,
 * optimistic-overlay reconciliation, and full-state-on-every-change delivery.
 * Domain backends call into this instead of bespoke `pb.subscribe` +
 * itemsMap + cancelled-flag bookkeeping.
 *
 * Public contract:
 *
 *   const mirror = createMirror(() => pb, wpb);
 *   const handle = mirror.watch(
 *     {
 *       collection: "shopping_items",
 *       topic: "*",
 *       filter: "list = 'L1'",
 *       predicate: r => r.list === "L1",
 *     },
 *     (records) => setState(records),
 *   );
 *   // ... later ...
 *   handle.unsubscribe();   // synchronous; safe at any time
 *
 * Design invariants:
 *
 *   1. `unsubscribe()` is synchronous and safe at every point in the watch
 *      lifecycle, including before the initial fetch resolves. The handle
 *      is the only public artifact; consumers never see `Promise<unsub>`.
 *
 *   2. ONE PB SSE listener per collection regardless of how many slices
 *      (filters / sorts / topics) watch it. Slices share the collection
 *      stream; each slice further routes by id/filter and emits its own
 *      state.
 *
 *   3. Mutation-queue overlay on every emit. Optimistic creates / updates /
 *      deletes appear in state immediately; server acks merge with no
 *      flicker (content-equal updates are dropped via JSON hash).
 *
 *   4. Sort + limit are server-side (initial fetch via `getList`, refetch
 *      on relevant SSE events). Client-side overlay re-applies sort+limit
 *      so optimistic creates rank correctly during the pre-ack window.
 *
 *   5. No watchdog. Recovery from SSE drop is handled by `resync()`,
 *      driven by focus/visibility events in the app shell.
 *
 * Implementation notes:
 *   - The mirror talks to the raw `pb` client for SSE + reads (so it can
 *     control top-N semantics itself). Optimistic-write events come in via
 *     the `__onMutation` side-channel on wpb, NOT through `pb.subscribe`.
 *   - A "slice" is keyed by (collection, topic, filter, sort, limit).
 *     Predicates are per-consumer because predicates aren't hashable.
 */

import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import type { WrappedPocketBase } from "./index";
import type { MutationQueue, RawRecord } from "./queue";

export { type RawRecord } from "./queue";

// ---- Public types ----

export interface WatchSpec {
  collection: string;
  topic: "*" | string;
  filter?: string;
  sort?: string;
  limit?: number;
  predicate?: (r: RawRecord) => boolean;
}

export interface WatchHandle {
  /** Synchronous teardown. Safe at any time, even before initial state. */
  unsubscribe: () => void;
}

export interface PBMirror {
  watch(spec: WatchSpec, onState: (records: RawRecord[]) => void): WatchHandle;
  watchCombined<T extends WatchSpec[]>(
    specs: [...T],
    onState: (states: { [K in keyof T]: RawRecord[] }) => void,
  ): WatchHandle;
  /** Re-runs initial fetch for every active slice; emits drift. */
  resync(): Promise<void>;
  /** Tear down everything. Callbacks become no-ops afterwards. */
  dispose(): void;
}

// ---- Internal types ----

/** Hidden side-channel on a WrappedPocketBase instance, set by wrapPocketBase.
 *  Don't widen this — the mirror lives in the same package and is the
 *  only legitimate consumer. */
interface InternalWpb extends WrappedPocketBase {
  __queue: MutationQueue;
  __onMutation: (cb: (collection: string, recordId: string) => void) => () => void;
}

interface Consumer {
  spec: WatchSpec;
  onState: (records: RawRecord[]) => void;
  cancelled: boolean;
}

interface Slice {
  key: string;
  spec: Omit<WatchSpec, "predicate">;
  consumers: Set<Consumer>;
  /** Server-known records inside the slice's filter/sort/limit window. The
   *  mutation queue layers on top of these at emit time. */
  records: Map<string, RawRecord>;
  /** True once initial fetch has resolved (or definitively failed) and the
   *  SSE listener is attached. */
  ready: boolean;
  /** Per-consumer last-emitted hash. Each consumer's view only emits when
   *  ITS materialized view changes (predicates differ across consumers). */
  perConsumerHash: WeakMap<Consumer, string>;
  /** Has this slice bumped the collection listener refcount yet? */
  listenerHeld: boolean;
  /** Refetch in flight (sort+limit window may have shifted). */
  refetchInFlight: Promise<void> | null;
  /** Another refetch was requested while one was in flight. */
  refetchAgain: boolean;
  /** True once teardown has started; gates re-entry. */
  tornDown: boolean;
}

interface CollectionListener {
  refcount: number;
  unsub: Promise<UnsubscribeFunc> | null;
}

// ---- Helpers ----

function sliceKey(spec: WatchSpec): string {
  return JSON.stringify({
    c: spec.collection,
    t: spec.topic,
    f: spec.filter ?? "",
    s: spec.sort ?? "",
    l: spec.limit ?? 0,
  });
}

/** Apply a PB-style sort string. Supports comma-separated fields with an
 *  optional `-` desc prefix. Ties break on `id` for determinism. */
function applySort(records: RawRecord[], sort?: string): RawRecord[] {
  if (!sort) return records;
  const parts = sort.split(",").map((p) => {
    const trimmed = p.trim();
    const desc = trimmed.startsWith("-");
    return { field: desc ? trimmed.slice(1) : trimmed, desc };
  });
  return records.slice().sort((a, b) => {
    for (const { field, desc } of parts) {
      const av = (a as Record<string, unknown>)[field];
      const bv = (b as Record<string, unknown>)[field];
      let cmp = 0;
      if (av === bv) cmp = 0;
      else if (av === undefined || av === null) cmp = -1;
      else if (bv === undefined || bv === null) cmp = 1;
      else if ((av as number | string) < (bv as number | string)) cmp = -1;
      else if ((av as number | string) > (bv as number | string)) cmp = 1;
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Cheap content hash — stringify with sorted keys, ignoring autodate
 *  `updated` so PB's stamp-bump on otherwise-identical updates doesn't
 *  force a no-op emit. */
function contentHash(records: RawRecord[]): string {
  return JSON.stringify(records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r).sort()) {
      if (k === "updated") continue;
      out[k] = (r as Record<string, unknown>)[k];
    }
    return out;
  }));
}

// ---- Implementation ----

export function createMirror(pb: () => PocketBase, wpb: WrappedPocketBase): PBMirror {
  const internal = wpb as InternalWpb;
  if (!internal.__queue || !internal.__onMutation) {
    throw new Error(
      "[mirror] WrappedPocketBase did not expose its __queue / __onMutation " +
      "side-channels. wrapPocketBase must set them.",
    );
  }
  const queue = internal.__queue;
  const slices = new Map<string, Slice>();
  const listeners = new Map<string, CollectionListener>();
  let disposed = false;

  // ---- Materialization ----

  /** Build a slice's current view with mutation-queue overlay.
   *
   *  Three shapes of slice, each with its own source of truth:
   *
   *    - topic=id: queue.view(col, id). One record or none.
   *    - sort+limit: slice.records is the server's top-N. Overlay
   *      optimistic mutations record-by-record, splice in pending-only
   *      records, re-apply local sort+limit.
   *    - filter-only wildcard: queue.viewCollection(col, predicate) IS
   *      the answer — predicate encodes the same logic as the server
   *      filter. slice.records is unused at materialization time; it
   *      only exists so SSE event routing knows which records the slice
   *      currently tracks (for the "delete event for unknown id" check).
   */
  function materialize(slice: Slice, predicate?: (r: RawRecord) => boolean): RawRecord[] {
    const col = slice.spec.collection;
    const topic = slice.spec.topic;

    if (topic !== "*") {
      // Single-record slice. queue.view returns null when the record was
      // optimistically deleted or never existed.
      const v = queue.view(col, topic);
      if (!v) return [];
      // Layer in the slice's known server snapshot if queue doesn't have one
      // (rare; SSE event without an active wpb subscription).
      const server = slice.records.get(topic);
      const final = v ?? server;
      if (!final) return [];
      if (predicate && !predicate(final)) return [];
      return [final];
    }

    if (slice.spec.sort || slice.spec.limit) {
      // Sort+limit slice. slice.records is the server's top-N window.
      // Overlay optimistic state on those, then splice in pending-only
      // records (e.g. optimistic creates that aren't on the server yet).
      const out = new Map<string, RawRecord>();
      for (const id of slice.records.keys()) {
        // Optimistic delete on a server-known record → omit.
        if (queue.hasPending(col, id) && queue.view(col, id) === null) continue;
        const v = queue.view(col, id) ?? slice.records.get(id)!;
        out.set(id, v);
      }
      // Pending-only records: anything in the queue without a slice.records
      // entry. Apply the per-consumer predicate to decide membership; the
      // server filter doesn't apply yet (server hasn't seen the write).
      for (const r of queue.viewPending(col)) {
        if (out.has(r.id)) continue;
        if (predicate && !predicate(r)) continue;
        out.set(r.id, r);
      }
      let result = Array.from(out.values());
      if (predicate) result = result.filter(predicate);
      if (slice.spec.sort) result = applySort(result, slice.spec.sort);
      if (slice.spec.limit && result.length > slice.spec.limit) {
        result = result.slice(0, slice.spec.limit);
      }
      return result;
    }

    // Filter-only wildcard slice. queue.viewCollection is the source of
    // truth: it returns every record with an overlay view (server + pending),
    // already filtered by the per-consumer predicate. This naturally covers:
    //   - server-known + optimistically-updated records (overlay)
    //   - optimistic creates with no server snapshot
    //   - optimistic deletes (omitted: composeView returns null)
    //   - server-side updates landed via SSE (we seed the queue in
    //     handleSseEvent so the queue knows about them)
    //
    // We seed the queue from initial-fetch in bootstrap() and from every
    // SSE event in handleSseEvent(), so slice.records is purely a routing
    // helper at this point — not consulted during materialization.
    return queue.viewCollection(col, predicate);
  }

  /** Emit to a consumer iff its view changed. */
  function deliverToConsumer(slice: Slice, consumer: Consumer): void {
    if (consumer.cancelled) return;
    const view = materialize(slice, consumer.spec.predicate);
    const hash = contentHash(view);
    const prev = slice.perConsumerHash.get(consumer);
    if (prev === hash) return;
    slice.perConsumerHash.set(consumer, hash);
    try {
      consumer.onState(view);
    } catch (err) {
      console.error("[mirror] consumer callback threw", err);
    }
  }

  /** Force an emit (skip hash check). Used after initial bootstrap so the
   *  consumer always gets exactly one emit, even if the view is empty. */
  function forceEmitConsumer(slice: Slice, consumer: Consumer): void {
    if (consumer.cancelled) return;
    const view = materialize(slice, consumer.spec.predicate);
    slice.perConsumerHash.set(consumer, contentHash(view));
    try {
      consumer.onState(view);
    } catch (err) {
      console.error("[mirror] consumer callback threw", err);
    }
  }

  function emitSlice(slice: Slice): void {
    for (const c of slice.consumers) deliverToConsumer(slice, c);
  }

  // ---- Collection-level SSE dispatch ----

  function ensureCollectionListener(collection: string): void {
    let l = listeners.get(collection);
    if (!l) {
      l = { refcount: 0, unsub: null };
      listeners.set(collection, l);
    }
    l.refcount += 1;
    if (l.unsub) return;

    // Subscribe via raw pb (NOT wpb) because we want exact control over
    // initial fetch shape (sort+limit) and we don't want wpb's own initial
    // getFullList that subscribe() does. Optimistic writes flow to the
    // mirror via the __onMutation hook below.
    l.unsub = pb().collection(collection).subscribe("*", (e) => {
      if (disposed) return;
      const action = e.action as "create" | "update" | "delete";
      const record = e.record as unknown as RawRecord;
      handleSseEvent(collection, action, record);
    });
  }

  function releaseCollectionListener(collection: string): void {
    const l = listeners.get(collection);
    if (!l) return;
    l.refcount -= 1;
    if (l.refcount > 0) return;
    const pending = l.unsub;
    l.unsub = null;
    listeners.delete(collection);
    if (pending) {
      void pending.then((u) => { try { u(); } catch { /* ignore */ } });
    }
  }

  /** Decide whether a record belongs in a given slice's window.
   *  Returns true if the slice should include this record (subject to
   *  per-consumer predicate, applied later). For topic-id slices, match
   *  by id. For wildcard slices we conservatively pass everything to
   *  the slice and let materialize() + per-consumer predicate trim. */
  function sliceShouldConsider(slice: Slice, record: RawRecord): boolean {
    return slice.spec.topic === "*" || slice.spec.topic === record.id;
  }

  function handleSseEvent(
    collection: string,
    action: "create" | "update" | "delete",
    record: RawRecord,
  ): void {
    // Keep the queue authoritative for every SSE event the mirror sees,
    // so queue.view / queue.viewCollection reflect server reality. Without
    // this, materialize() couldn't tell that a server-side update happened
    // for a slice that watches a filter-only wildcard.
    if (action === "delete") {
      queue.applyServer(collection, record.id, null);
    } else {
      queue.applyServer(collection, record.id, record);
    }

    for (const slice of slices.values()) {
      if (slice.spec.collection !== collection) continue;
      if (!sliceShouldConsider(slice, record)) continue;

      const id = record.id;
      const had = slice.records.has(id);

      if (action === "delete") {
        if (!had) {
          // Delete for an id this slice doesn't track — skip emit to
          // avoid spurious churn (scenario 16).
          continue;
        }
        slice.records.delete(id);
      } else {
        // create or update — upsert into slice.records.
        slice.records.set(id, record);
      }

      // For sort+limit slices, the window may have shifted — refetch.
      // (For wildcard non-sort/limit slices we don't refetch on every
      // event; slice.records IS the full window and we just updated it.)
      if (slice.spec.sort || slice.spec.limit) {
        scheduleRefetch(slice);
        // Don't emit yet — emit after the refetch lands.
      } else {
        emitSlice(slice);
      }
    }
  }

  /** Debounced refetch for sort+limit slices. */
  function scheduleRefetch(slice: Slice): void {
    if (slice.refetchInFlight) {
      slice.refetchAgain = true;
      return;
    }
    slice.refetchInFlight = (async () => {
      try {
        const { collection, filter, sort, limit } = slice.spec;
        const result = await pb().collection(collection).getList(1, limit ?? 500, {
          filter: filter ?? "",
          sort: sort ?? "",
          $autoCancel: false,
        });
        if (slice.tornDown || slice.consumers.size === 0) return;
        const next = new Map<string, RawRecord>();
        for (const r of result.items as unknown as RawRecord[]) next.set(r.id, r);
        slice.records = next;
        emitSlice(slice);
      } catch {
        // Network blip — leave records as-is; next event or resync will recover.
      } finally {
        slice.refetchInFlight = null;
        if (slice.refetchAgain) {
          slice.refetchAgain = false;
          scheduleRefetch(slice);
        }
      }
    })();
  }

  // ---- Mutation queue hook (optimistic writes) ----

  const unhookMutation = internal.__onMutation((collection, _recordId) => {
    if (disposed) return;
    for (const slice of slices.values()) {
      if (slice.spec.collection !== collection) continue;
      if (!slice.ready) continue;
      // For sort+limit slices, the optimistic record might now be in the
      // top-N. We don't refetch from the server (it doesn't know yet) —
      // materialize() handles it via queue.viewPending overlay + local
      // sort+limit.
      emitSlice(slice);
    }
  });

  // ---- Bootstrap ----

  async function bootstrap(slice: Slice): Promise<void> {
    const { collection, topic, filter, sort, limit } = slice.spec;

    let initial: RawRecord[] = [];
    try {
      if (topic !== "*") {
        try {
          const r = await pb().collection(collection).getOne(topic, { $autoCancel: false });
          initial = [r as unknown as RawRecord];
        } catch (err) {
          if ((err as { status?: number })?.status !== 404) {
            // Non-404 transient — leave initial empty; resync will retry.
          }
        }
      } else if (sort || limit) {
        try {
          const result = await pb().collection(collection).getList(1, limit ?? 500, {
            filter: filter ?? "",
            sort: sort ?? "",
            $autoCancel: false,
          });
          initial = result.items as unknown as RawRecord[];
        } catch { /* leave empty */ }
      } else if (filter !== undefined) {
        try {
          const rs = await pb().collection(collection).getFullList({ filter, $autoCancel: false });
          initial = rs as unknown as RawRecord[];
        } catch { /* leave empty */ }
      } else {
        // Unfiltered "*" wildcard — no canonical initial set.
        initial = [];
      }
    } catch (err) {
      console.warn("[mirror] bootstrap fetch failed", { collection, topic }, err);
    }

    // Cancel-before-resolve: bail if all consumers gone during the fetch.
    // Critically this happens BEFORE we attach an SSE listener — no
    // wasted pb.subscribe call (scenarios 7, 9).
    if (slice.tornDown || slice.consumers.size === 0) return;

    // Seed slice.records AND the mutation queue. Seeding the queue is the
    // key to making queue.viewCollection() the single source of truth in
    // materialize() — otherwise the initial filtered set would only live
    // in slice.records and the queue overlay would be partial.
    //
    // The seed-skip guard is intentionally narrow: only skip when the
    // queue ALREADY has a server snapshot for this id (an SSE event
    // raced ahead during our await — that snapshot is more authoritative
    // than our potentially-stale getList). A pending-only entry must NOT
    // skip the seed: a stale persisted SET replayed from IDB does not
    // constitute server truth, and without the server seed, composeView
    // would (a) show the stale create-time body to consumers, and (b)
    // leave the record with no server snapshot when the replay's 409
    // drains the pending — making the record vanish entirely. This is
    // the dogfood oscillation bug (A11/A12 in realworld.test.ts).
    for (const r of initial) {
      slice.records.set(r.id, r);
      if (!queue.hasServerSnapshot(collection, r.id)) {
        queue.applyServer(collection, r.id, r);
      }
    }

    // Attach SSE listener (refcount per collection).
    ensureCollectionListener(collection);
    slice.listenerHeld = true;

    if (slice.tornDown || slice.consumers.size === 0) {
      // Cancelled in the gap between refcount-bump and now. Release.
      releaseCollectionListener(collection);
      slice.listenerHeld = false;
      return;
    }

    slice.ready = true;

    // Deliver initial state to every consumer attached so far.
    for (const consumer of slice.consumers) {
      forceEmitConsumer(slice, consumer);
    }
  }

  // ---- Teardown ----

  function teardownSlice(slice: Slice): void {
    if (slice.tornDown) return;
    slice.tornDown = true;
    slices.delete(slice.key);
    if (slice.listenerHeld) {
      releaseCollectionListener(slice.spec.collection);
      slice.listenerHeld = false;
    }
  }

  // ---- Public methods ----

  function watch(spec: WatchSpec, onState: (records: RawRecord[]) => void): WatchHandle {
    if (disposed) return { unsubscribe: () => {} };

    const key = sliceKey(spec);
    let slice = slices.get(key);
    if (!slice) {
      slice = {
        key,
        spec: {
          collection: spec.collection,
          topic: spec.topic,
          filter: spec.filter,
          sort: spec.sort,
          limit: spec.limit,
        },
        consumers: new Set(),
        records: new Map(),
        ready: false,
        perConsumerHash: new WeakMap(),
        listenerHeld: false,
        refetchInFlight: null,
        refetchAgain: false,
        tornDown: false,
      };
      slices.set(key, slice);
    }

    const consumer: Consumer = { spec, onState, cancelled: false };
    slice.consumers.add(consumer);

    if (slice.ready) {
      // Slice already bootstrapped — deliver after a microtask to match
      // the async-ordering contract of a fresh watch.
      void Promise.resolve().then(() => {
        if (consumer.cancelled || !slices.has(slice!.key)) return;
        forceEmitConsumer(slice!, consumer);
      });
    } else if (slice.consumers.size === 1) {
      // First consumer triggers bootstrap (fire-and-forget).
      void bootstrap(slice);
    }
    // Else: bootstrap in flight; consumer will be emitted to at the end.

    return {
      unsubscribe: () => {
        consumer.cancelled = true;
        slice!.consumers.delete(consumer);
        if (slice!.consumers.size === 0) teardownSlice(slice!);
      },
    };
  }

  function watchCombined<T extends WatchSpec[]>(
    specs: [...T],
    onState: (states: { [K in keyof T]: RawRecord[] }) => void,
  ): WatchHandle {
    const states: RawRecord[][] = specs.map(() => []);
    const ready: boolean[] = specs.map(() => false);
    let cancelled = false;
    const handles: WatchHandle[] = [];

    for (let i = 0; i < specs.length; i++) {
      const idx = i;
      const h = watch(specs[i], (s) => {
        if (cancelled) return;
        states[idx] = s;
        ready[idx] = true;
        if (ready.every(Boolean)) {
          try {
            onState(states.slice() as { [K in keyof T]: RawRecord[] });
          } catch (err) {
            console.error("[mirror] combined callback threw", err);
          }
        }
      });
      handles.push(h);
    }

    return {
      unsubscribe: () => {
        cancelled = true;
        for (const h of handles) h.unsubscribe();
      },
    };
  }

  async function resync(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const slice of Array.from(slices.values())) {
      if (slice.consumers.size === 0) continue;
      work.push((async () => {
        const { collection, topic, filter, sort, limit } = slice.spec;
        let fresh: RawRecord[] = [];
        try {
          if (topic !== "*") {
            try {
              const r = await pb().collection(collection).getOne(topic, { $autoCancel: false });
              fresh = [r as unknown as RawRecord];
            } catch (err) {
              if ((err as { status?: number })?.status === 404) fresh = [];
              else return;
            }
          } else if (sort || limit) {
            const result = await pb().collection(collection).getList(1, limit ?? 500, {
              filter: filter ?? "",
              sort: sort ?? "",
              $autoCancel: false,
            });
            fresh = result.items as unknown as RawRecord[];
          } else if (filter !== undefined) {
            const rs = await pb().collection(collection).getFullList({ filter, $autoCancel: false });
            fresh = rs as unknown as RawRecord[];
          } else {
            return;
          }
        } catch {
          return;
        }

        if (slice.tornDown || slice.consumers.size === 0) return;

        // Reconcile: anything in the prior slice.records that's MISSING
        // from the refresh and has no pending mutation → deleted server-side
        // during the disconnect window. Apply a queue tombstone so
        // queue.viewCollection drops them.
        const next = new Map<string, RawRecord>();
        for (const r of fresh) next.set(r.id, r);
        const seen = new Set(next.keys());
        for (const oldId of slice.records.keys()) {
          if (seen.has(oldId)) continue;
          if (queue.hasPending(collection, oldId)) continue;
          queue.applyServer(collection, oldId, null);
        }
        // Seed the queue with the fresh data so queue.viewCollection has it.
        // applyServer composes under any pending overlay (the user's
        // optimistic writes survive), so unconditionally writing through
        // is safe and necessary: the consumer's view must reflect the
        // freshest server truth underneath whatever optimistic state the
        // queue currently holds.
        for (const r of fresh) {
          queue.applyServer(collection, r.id, r);
        }
        slice.records = next;
        emitSlice(slice);
      })());
    }
    await Promise.all(work);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const slice of Array.from(slices.values())) {
      for (const c of slice.consumers) c.cancelled = true;
      slice.consumers.clear();
      teardownSlice(slice);
    }
    slices.clear();
    try { unhookMutation(); } catch { /* ignore */ }
    // Drain any remaining listeners (should be none if teardownSlice did
    // its job, but be defensive).
    for (const collection of Array.from(listeners.keys())) {
      const l = listeners.get(collection);
      if (!l) continue;
      l.refcount = 0;
      const pending = l.unsub;
      l.unsub = null;
      listeners.delete(collection);
      if (pending) void pending.then((u) => { try { u(); } catch { /* ignore */ } });
    }
  }

  return { watch, watchCombined, resync, dispose };
}
