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
 *   5. No watchdog. Recovery from SSE drop is handled by `resync()`, driven by
 *      TWO complementary triggers: the mirror's own onDisconnect→PB_CONNECT
 *      hook (precise — fires the instant a real drop reconnects) and the app
 *      shell's focus/visibility events (the backstop for silent mobile
 *      suspends the SDK never notices). See the realtimeDirty block below.
 *
 * Implementation notes:
 *   - The mirror talks to the raw `pb` client for SSE + reads (so it can
 *     control top-N semantics itself). Optimistic-write events come in via
 *     wpb.mirrorIntegration.subscribeMutations, NOT through `pb.subscribe`.
 *   - A "slice" is keyed by (collection, topic, filter, sort, limit).
 *     Predicates are per-consumer because predicates aren't hashable.
 */

import type PocketBase from "pocketbase";
import type { UnsubscribeFunc } from "pocketbase";
import type { WrappedPocketBase } from "./index";
import type { RawRecord } from "./queue";

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
  /** Re-runs initial fetch for every active slice; emits drift.
   *  The backstop path (focus/visibility, via `useRealtimeResync`) calls this
   *  with no args and is coalesced. `force: true` is the reconnect path —
   *  bypasses coalescing (see RESYNC_COALESCE_MS). */
  resync(opts?: { force?: boolean }): Promise<void>;
  /** Tear down everything. Callbacks become no-ops afterwards. */
  dispose(): void;
}

// ---- Internal types ----

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
  /**
   * True once bootstrap's consolidation has run AND consumed the touched-set
   * (set at the sseTouchedDuringBootstrap.clear() site, before the registration
   * await). Distinct from `ready` ON PURPOSE.
   *
   * Why decouple touched-set population from `ready`: a WARM-CACHE slice
   * (shopping_items / shopping_trips for every returning user) eager-paints from
   * the snapshot cache and sets `ready = true` BEFORE the network fetch resolves
   * (eagerEmitFromCache). If touched-set population were keyed on `!ready`, an
   * SSE event during that in-flight fetch would take the already-ready path and
   * NEVER enter sseTouchedDuringBootstrap — then bootstrap's consolidation, which
   * still runs against a fetch result that PREDATES the event, would tombstone a
   * pre-fetch create / resurrect a pre-fetch delete with an empty touched-set
   * (the Blocker-1/2 corruption, on the steady-state path). Keying population on
   * `!consolidated` instead means the touched-set is populated for the entire
   * pre-consolidation window regardless of eager readiness; only the EMIT path
   * stays gated on `ready` (eager-ready slices emit live SSE immediately). */
  consolidated: boolean;
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
  /**
   * True iff a pre-consolidation SSE DELETE or (demotion-capable) UPDATE touched
   * a sort+limit slice during its bootstrap window. Arms the post-ready backfill
   * refetch.
   *
   * Why UPDATE, not just DELETE: the bootstrap getList returns only the top-N. A
   * pre-ready DELETE of a windowed row obviously vacates a slot. But so does a
   * pre-ready UPDATE that DEMOTES a windowed row below the top-N (lowers its sort
   * key): the slot it vacates should be filled by the next-ranked below-window
   * record — which the top-N-only fetch never pulled in. Neither is recoverable
   * from `slice.records ∪ pending` alone (the promoted record is in neither), so
   * re-query the top-N once consolidated. (Pre-fix the code armed only on DELETE,
   * with a "creates/updates never under-fill" comment — false for a demotion.) A
   * plain CREATE genuinely never under-fills: it either enters the window
   * (evicting the lowest FETCHED row, still tracked) or stays out — no vacancy
   * needing a below-window promotion — so it does NOT arm this.
   * scheduleRefetch self-coalesces, so an extra getList here is harmless. */
  windowDirtyDuringBootstrap: boolean;
  /**
   * Ids the mirror has seen DELETED over SSE for which a sort+limit refetch's
   * getList might still return a STALE row. A refetch's getList can snapshot the
   * server BEFORE a delete the mirror already consumed (a gated/slow fetch, or a
   * server commit lagging its own broadcast), so replacing slice.records with
   * that result would RESURRECT a just-deleted row. We can't read "tombstoned"
   * off the queue — applyServer(null) with no pending DELETES the queue entry,
   * making it indistinguishable from a never-seen below-window record that the
   * refetch legitimately PROMOTES into the window. So track deleted ids
   * explicitly: the refetch drops any result row in this set UNLESS the queue has
   * since gained a live server snapshot for it (recreated → keep). Pruned in the
   * refetch once the row is confirmed gone, so it can't grow unbounded. */
  pendingWindowTombstones: Set<string>;
  /**
   * Ids the LIVE SSE listener authoritatively touched DURING the pre-ready
   * bootstrap window (create / update / delete). See the pre-ready-window
   * commentary in handleSseEvent + bootstrap.
   *
   * Why this exists: the SSE listener now attaches CONCURRENTLY with the
   * initial fetch (Part A — to overlap registration latency). So an SSE event
   * for the collection can land in the queue + slice.records BEFORE the fetch
   * resolves. Bootstrap's consolidation (seed loop / reconcileGhosts /
   * sort+limit slice.records replace) then runs AFTER, against a fetch result
   * that PREDATES those events. Without a record of "the live listener already
   * spoke for this id," consolidation would corrupt the fresher live state:
   *   - reconcileGhosts would tombstone a live CREATE absent from the fetch,
   *   - the seed loop would resurrect a live DELETE (re-seed the stale row),
   *   - the sort+limit replace would drop a live event the fetch can't see.
   * Every consumer of this set treats a touched id as "live truth already
   * applied — do not let the older fetch overwrite it." Cleared once bootstrap
   * consolidation consumes it (the slice is then `ready`, so future SSE events
   * emit directly and never enter this set). */
  sseTouchedDuringBootstrap: Set<string>;
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
  if (!wpb.mirrorIntegration) {
    throw new Error(
      "[mirror] WrappedPocketBase did not expose its mirrorIntegration surface. " +
      "wrapPocketBase must set it.",
    );
  }
  const { queue, subscribeMutations } = wpb.mirrorIntegration;
  const slices = new Map<string, Slice>();
  const listeners = new Map<string, CollectionListener>();
  let disposed = false;

  // ---- Reconnect-driven resync (precise trigger) ----
  //
  // resync() has TWO complementary triggers, and BOTH must exist:
  //
  //   1. PB_CONNECT after a real SSE drop (this block). The PB SDK reports
  //      the disconnect via realtime.onDisconnect and fires PB_CONNECT on the
  //      next (re)connect. We resync the instant SSE returns, so the failure
  //      window is seconds — not "whenever the user next happens to refocus
  //      the tab." This is the common desktop / wifi-blip path.
  //
  //   2. focus / pageshow / visibilitychange (backend-provider's
  //      useRealtimeResync). This is the backstop for SILENT mobile suspends:
  //      iOS Safari (and friends) freeze the network stack on tab-suspend, so
  //      the SDK's EventSource never sees a clean close — no onDisconnect, no
  //      PB_CONNECT. Focus-on-resume is the ONLY signal that catches that case.
  //
  // Do NOT delete either as "redundant." Trigger 1 absorbs the common
  // desktop case so focus isn't doing a full refetch on every routine
  // alt-tab; trigger 2 is the only thing that recovers the silent-suspend
  // case. Together they give precise steady-state cost with no loss of
  // recovery guarantee.
  //
  // CRITICAL: PB_CONNECT fires on the INITIAL connect too. Resyncing then
  // would duplicate the per-slice bootstrap fetch. The `realtimeDirty` flag
  // gates this — only a prior onDisconnect (with live subscriptions) arms it.
  let realtimeDirty = false;
  let realtimeHooked = false;
  /** Prior onDisconnect handler to chain (e.g. wpb's, or another hook). */
  let prevOnDisconnect: ((activeSubs: string[]) => void) | undefined;
  /** OUR onDisconnect handler — kept so dispose restores prevOnDisconnect only
   *  if we're still the installed handler (single-slot "restore if on top"). */
  let ourOnDisconnect: ((activeSubs: string[]) => void) | undefined;
  /** Pending unsubscribe for the PB_CONNECT listener; torn down in dispose. */
  let pbConnectUnsub: Promise<UnsubscribeFunc> | null = null;
  /**
   * Coalesce window — applies ONLY to the focus/visibility backstop path
   * (the public `resync()` called by `useRealtimeResync`). A backstop resync
   * landing within this window of the last one is suppressed: it's the blunt
   * trigger and a redundant full-refetch on a routine alt-tab is pure waste.
   *
   * The reconnect path (onDisconnect→PB_CONNECT, `resync({ force: true })`)
   * deliberately BYPASSES this window. Reconnect is the precise, authoritative
   * signal — a real SSE drop+reconnect — and it must always fetch. The hazard
   * the bypass fixes: on a mobile wake, focus fires first (stamping
   * `lastResyncAt`), then the network returns and SSE reconnects ~1-2s later
   * INSIDE the window. A symmetric coalesce would drop that reconnect-resync;
   * and because the PB_CONNECT handler already cleared `realtimeDirty` before
   * calling resync, the drop is silent → stale data until the next trigger.
   * Forcing the reconnect path re-stamps `lastResyncAt` so a focus event
   * trailing the reconnect is still coalesced.
   *
   * Wide enough to absorb the "PB_CONNECT then focus-on-resume back-to-back"
   * race in the other direction (focus after a forced reconnect is skipped),
   * narrow enough that a genuinely-later focus still resyncs. Double-refetch is
   * harmless (idempotent, JSON-hash-deduped emits) — this just trims the waste.
   */
  const RESYNC_COALESCE_MS = 2000;
  let lastResyncAt = 0;

  /**
   * Upper bound on how long bootstrap waits for SSE registration to land before
   * it marks the slice ready and emits anyway. Generous on purpose: a local-PB
   * registration always wins this race (so tests are deterministic — the await
   * closes the lost-pre-registration-event window before the timeout fires),
   * but it's bounded so a hung SSE connect can never blank the app
   * indefinitely. The pathological slow-connect case degrades to the old
   * behavior (emit fresh state without a confirmed listener) and is recovered
   * by resync() on focus/PB_CONNECT — the standing safety net for events missed
   * while the SSE was not yet live. */
  const SUBSCRIBE_READY_TIMEOUT_MS = 10000;

  /** Surface a bootstrap/refetch failure to wpb's debug ring buffer so
   *  SyncDot + window.__wpbDebug see a unified event feed. Cheap; no need
   *  to gate on env. */
  function recordBootstrapError(
    collection: string,
    topic: string,
    err: unknown,
    phase: "bootstrap" | "refetch" | "resync",
  ): void {
    const status = (err as { status?: number; message?: string })?.status;
    const message = (err as { message?: string })?.message;
    wpb.debug.recordEvent({
      kind: "bootstrap-error",
      collection,
      detail: { topic, phase, status, message },
    });
  }

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

  /**
   * Fire-and-forget unsubscribe that swallows both sync throws AND async
   * rejections. The PB SDK's `unsubscribe` returned from `realtime.subscribe`
   * POSTs to `/api/realtime`; it returns a Promise which can reject with:
   *
   *   - 404 "Missing or invalid client id" — SSE connection never fully
   *     established before teardown (test finishes fast; rapid mount/unmount
   *     in dev; auth-change reset between subscribe and unsubscribe).
   *   - Network errors on page-hide.
   *
   * The previous `try { u(); } catch {}` pattern only caught sync throws;
   * the async rejection escaped as an unhandled rejection, which vitest
   * treats as a test failure even though the assertion suite passed. The
   * realtime channel is already torn down server-side, so there's nothing
   * to do with the rejection — silence it on both edges.
   */
  function safeFireAndForgetUnsub(pending: Promise<UnsubscribeFunc>): void {
    pending
      .then((u) => {
        try {
          // u() returns void in @types but Promise<void> at runtime.
          const r = (u as unknown as () => unknown)();
          if (r && typeof (r as Promise<unknown>).then === "function") {
            (r as Promise<unknown>).catch(() => { /* stale clientId — ignore */ });
          }
        } catch { /* ignore */ }
      })
      .catch(() => { /* subscribe itself rejected late — ignore */ });
  }

  /**
   * Arm the reconnect-driven resync. Hooked lazily on the first collection
   * listener (the earliest the mirror actually touches the realtime channel),
   * so a mirror that's constructed but never watched — or a Node e2e run that
   * never opens an EventSource — pays nothing.
   *
   * Wrapped in try/catch because the PB SDK's realtime.subscribe synchronously
   * constructs `new EventSource(...)`, which throws in Node-side e2e tests
   * that never subscribe. Mirrors the guard in wpb's hookRealtimeLifecycle.
   */
  function hookRealtimeLifecycle(): void {
    if (realtimeHooked) return;
    const client = pb();
    const rt = client.realtime as unknown as {
      onDisconnect?: (activeSubs: string[]) => void;
      subscribe?: (topic: string, cb: () => void) => Promise<UnsubscribeFunc>;
    } | undefined;
    if (!rt || typeof rt.subscribe !== "function") return;

    // Chain (don't clobber) any existing onDisconnect — wpb may have its own,
    // and the SDK exposes exactly one slot.
    prevOnDisconnect = rt.onDisconnect;
    // Capture OUR handler in a local so dispose can restore the prior handler
    // ONLY if we're still the one installed (the standard "restore only if
    // you're on top" discipline for a single-slot global). With two mirrors
    // chained on one pb (M2→M1→orig), a blind restore on M1's dispose would
    // clobber M2's live handler; the identity check prevents that. The closure
    // is also post-dispose-inert: the `disposed` guard makes a late fire a
    // no-op (realtimeDirty arming a disposed mirror is harmless — no slices).
    ourOnDisconnect = (activeSubs: string[]) => {
      // Only arm on a drop that actually loses live subscriptions. An
      // unsubscribe-all teardown (dispose, last consumer leaving) also fires
      // onDisconnect with no active subs — that's a graceful close, not a
      // drop, and must not trigger a resync.
      if (!disposed && activeSubs && activeSubs.length > 0) realtimeDirty = true;
      try { prevOnDisconnect?.(activeSubs); } catch { /* other hook's error is theirs */ }
    };
    rt.onDisconnect = ourOnDisconnect;

    try {
      pbConnectUnsub = rt.subscribe("PB_CONNECT", () => {
        // Initial connect (and reconnects after a graceful close) leave
        // realtimeDirty false — bootstrap already fetched, so skip.
        if (!realtimeDirty) return;
        realtimeDirty = false;
        // force: bypass the focus-coalesce window. Reconnect is the precise,
        // authoritative drop signal — it must always fetch even if a focus
        // event just stamped lastResyncAt (mobile-wake ordering). See resync().
        void resync({ force: true });
      });
      // Mark hooked only after a clean install, so a late subscribe rejection
      // (below) can unwind to a clean slate for a future re-entry.
      realtimeHooked = true;
      if (pbConnectUnsub && typeof (pbConnectUnsub as Promise<unknown>).catch === "function") {
        (pbConnectUnsub as Promise<unknown>).catch(() => {
          // Late subscribe rejection: unwind so re-entry starts clean. Restore
          // onDisconnect to the prior handler (only if we're still on top) so
          // a re-hook doesn't read OUR handler as prevOnDisconnect (self-chain).
          try {
            const r = (pb().realtime as unknown) as { onDisconnect?: unknown } | undefined;
            if (r && r.onDisconnect === ourOnDisconnect) r.onDisconnect = prevOnDisconnect;
          } catch { /* SDK without realtime — nothing to restore */ }
          pbConnectUnsub = null;
          realtimeHooked = false;
        });
      }
    } catch {
      // EventSource unavailable (Node) — stay un-hooked. Focus/visibility
      // resync in the app shell still recovers from drops. Restore the slot
      // (only if we're on top) so a future re-entry sees the original handler.
      try {
        const r = (pb().realtime as unknown) as { onDisconnect?: unknown } | undefined;
        if (r && r.onDisconnect === ourOnDisconnect) r.onDisconnect = prevOnDisconnect;
      } catch { /* ignore */ }
      realtimeHooked = false;
      pbConnectUnsub = null;
    }
  }

  /**
   * Ensure a shared per-collection SSE listener exists; bump its refcount.
   *
   * Returns a Promise that resolves once the underlying `subscribe("*")`
   * registration has COMPLETED — the PB SDK resolves the subscribe Promise only
   * after its POST to `/api/realtime` lands (connection established +
   * subscription registered server-side). bootstrap() awaits this (raced
   * against a timeout) before it marks a slice ready, to close the
   * lost-pre-registration-event race: PocketBase does NOT replay events
   * broadcast before a subscription is registered, so a producer firing right
   * when a fresh consumer subscribes would otherwise be lost until resync().
   *
   * The returned Promise NEVER rejects — a late registration rejection (network
   * blip on the POST) is swallowed and surfaced as "ready immediately" so the
   * readiness await can't throw or leave the slice stuck un-ready. resync()
   * recovers any events missed on a registration that failed.
   *
   * Node / no-EventSource safety: if `subscribe` throws synchronously (e.g.
   * `EventSource is not defined` in the Node e2e harness without a polyfill) we
   * resolve immediately rather than reject — there's no realtime channel to
   * wait for, so the slice becomes ready right away. `l.unsub` stays null;
   * teardown is a no-op. */
  function ensureCollectionListener(collection: string): Promise<void> {
    // First realtime touch — arm the reconnect→resync hook once.
    hookRealtimeLifecycle();
    let l = listeners.get(collection);
    if (!l) {
      l = { refcount: 0, unsub: null };
      listeners.set(collection, l);
    }
    l.refcount += 1;
    // Already registered (or registration in flight) from another slice — reuse
    // its registration signal so this slice's readiness gate waits on the same
    // POST. Map both fulfil + reject to undefined (never throw to the awaiter).
    if (l.unsub) return l.unsub.then(() => undefined, () => undefined);

    // Subscribe via raw pb (NOT wpb) because we want exact control over
    // initial fetch shape (sort+limit) and we don't want wpb's own initial
    // getFullList that subscribe() does. Optimistic writes flow to the
    // mirror via the mirrorIntegration.subscribeMutations hook below.
    try {
      l.unsub = pb().collection(collection).subscribe("*", (e) => {
        if (disposed) return;
        const action = e.action as "create" | "update" | "delete";
        const record = e.record as unknown as RawRecord;
        handleSseEvent(collection, action, record);
      });
    } catch {
      // Synchronous throw (no EventSource in this env). No channel to await.
      l.unsub = null;
      return Promise.resolve();
    }
    return l.unsub.then(() => undefined, () => undefined);
  }

  function releaseCollectionListener(collection: string): void {
    const l = listeners.get(collection);
    if (!l) return;
    l.refcount -= 1;
    if (l.refcount > 0) return;
    const pending = l.unsub;
    l.unsub = null;
    listeners.delete(collection);
    if (pending) safeFireAndForgetUnsub(pending);
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
        // A pre-ready delete for an id the fetch will still carry must be
        // recorded BEFORE the `!had` early-out: even if the slice doesn't yet
        // track the id (bootstrap hasn't seeded slice.records), the live
        // listener has authoritatively seen it deleted, and the consolidation
        // (seed loop / sort+limit replace) must not resurrect it. queue.apply
        // Server(null) above already tombstoned it in the queue.
        // Keyed on `!consolidated` (NOT `!ready`): a warm-cache slice goes ready
        // early via eager paint, but bootstrap's consolidation hasn't run yet —
        // it must still see this id in the touched-set. See `consolidated` doc.
        if (!slice.consolidated) {
          slice.sseTouchedDuringBootstrap.add(id);
          // sort+limit under-fill: a pre-consolidation DELETE vacates a window
          // slot, so bootstrap must re-query the top-N once consolidated.
          if (slice.spec.sort || slice.spec.limit) {
            slice.windowDirtyDuringBootstrap = true;
          }
        }
        // sort+limit: remember this delete so a subsequent (possibly stale)
        // refetch can't resurrect the just-deleted row — see
        // pendingWindowTombstones. Recorded for ALL deletes (pre- and post-ready)
        // and BEFORE the `!had` early-out, since a row demoted out of the window
        // can be deleted while slice.records no longer tracks it.
        if (slice.spec.sort || slice.spec.limit) {
          slice.pendingWindowTombstones.add(id);
        }
        if (!had) {
          // Delete for an id this slice doesn't track — skip emit to
          // avoid spurious churn (scenario 16).
          continue;
        }
        slice.records.delete(id);
      } else {
        // create or update — upsert into slice.records.
        // Keyed on `!consolidated` (NOT `!ready`) for the warm-cache eager-paint
        // case — see the delete branch above and the `consolidated` doc.
        if (!slice.consolidated) {
          slice.sseTouchedDuringBootstrap.add(id);
          // sort+limit under-fill: arm a post-ready re-query for an UPDATE only.
          // An UPDATE can DEMOTE a windowed row below the top-N — vacating a slot
          // the below-window (never-fetched) record should promote into, which
          // the consolidated `slice.records ∪ pending` can't supply. A CREATE
          // does NOT under-fill: it either enters the window (evicting the lowest
          // FETCHED row, which is still tracked) or stays out — no vacancy needing
          // a below-window promotion. (A delete arms via its own branch above.)
          if ((slice.spec.sort || slice.spec.limit) && action === "update") {
            slice.windowDirtyDuringBootstrap = true;
          }
        }
        slice.records.set(id, record);
      }

      // CONSOLIDATED-BUT-NOT-READY window: there is a gap between bootstrap
      // setting `consolidated = true` (it has folded the touched-set into the
      // fetch result) and `ready = true` (it awaits SSE registration in
      // between). A sort+limit window-affecting event landing in THAT gap is
      // missed by both arming paths: the touched-set / windowDirty arming keys
      // on `!consolidated` (already false), and the post-ready refetch below
      // keys on `ready` (not yet true) — so the window would render the demoted
      // value with no backfill until the next resync. Since consolidation has
      // run, a refetch is safe to schedule now; its emit is harmless because the
      // per-consumer hash dedups against bootstrap's imminent force-emit.
      if (!slice.ready) {
        if (slice.consolidated && (slice.spec.sort || slice.spec.limit)) {
          scheduleRefetch(slice);
        }
        // Otherwise (truly pre-consolidation) we've already recorded the event
        // in the queue + slice.records + touched-set/windowDirty above;
        // bootstrap's consolidation + force-emit delivers the first view. We must
        // NOT emit a partial pre-bootstrap view here. Mirrors the mutation hook's
        // `if (!slice.ready) continue`.
        continue;
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

  /** Debounced refetch for sort+limit slices.
   *
   *  A refetch's getList can be STALE relative to SSE deletes the mirror has
   *  already consumed: the getList query may snapshot the server BEFORE a delete
   *  the mirror saw over SSE (e.g. a fetch issued while reads are slow, or a
   *  server commit lagging its own broadcast). Replacing slice.records with such
   *  a result would RESURRECT a just-deleted row. slice.pendingWindowTombstones
   *  records the ids the mirror has seen deleted; we drop any result row in that
   *  set UNLESS the queue has since gained a live server snapshot for it (the row
   *  was re-created after the delete → keep it). A row confirmed gone (absent
   *  from the result, or dropped here) is pruned from the set so it can't grow.
   *  Below-window records the result legitimately PROMOTES are NOT in the set, so
   *  they're retained — the case a naive "drop everything the queue lacks a
   *  snapshot for" check would wrongly discard. */
  function scheduleRefetch(slice: Slice): void {
    if (slice.refetchInFlight) {
      slice.refetchAgain = true;
      return;
    }
    slice.refetchInFlight = (async () => {
      const { collection, topic, filter, sort, limit } = slice.spec;
      try {
        const result = await pb().collection(collection).getList(1, limit ?? 500, {
          filter: filter ?? "",
          sort: sort ?? "",
          $autoCancel: false,
        });
        if (slice.tornDown || slice.consumers.size === 0) return;
        const items = result.items as unknown as RawRecord[];
        const resultWasFull = limit !== undefined && items.length >= limit;
        const next = new Map<string, RawRecord>();
        let droppedTombstone = false;
        for (const r of items) {
          // Stale-delete guard: drop a row the mirror knows was deleted, unless
          // it has since been re-created (live queue snapshot). See fn doc.
          if (
            slice.pendingWindowTombstones.has(r.id) &&
            !queue.hasServerSnapshot(collection, r.id)
          ) {
            droppedTombstone = true;
            continue;
          }
          next.set(r.id, r);
        }
        // Prune tombstones the getList result no longer carries — those are
        // confirmed gone server-side, so we never need to suppress them again.
        // KEEP a tombstone the result STILL carries (a server commit lagging its
        // broadcast): we dropped it above, and the next refetch must drop it
        // again until the server stops returning it. (Pruning on `next`, which
        // already excludes the just-dropped row, would forget the tombstone and
        // let the very next refetch resurrect it.)
        const resultIds = new Set(items.map((r) => r.id));
        for (const id of Array.from(slice.pendingWindowTombstones)) {
          if (!resultIds.has(id)) slice.pendingWindowTombstones.delete(id);
        }
        slice.records = next;
        // If we dropped a tombstoned row from a result that was AT THE LIMIT, the
        // page was full — the dropped slot pushed a below-window record off the
        // page, so it was never fetched and the window is now under-filled.
        // Re-query so the promotion lands. A SHORT result can't have lost a
        // promotion (everything matching fit on the page), so we do NOT re-arm —
        // that also avoids an unterminating refetch loop when the server keeps
        // returning a not-yet-committed delete. refetchAgain coalesces with any
        // event-driven request.
        if (droppedTombstone && resultWasFull) slice.refetchAgain = true;
        emitSlice(slice);
      } catch (err) {
        // Network blip — leave records as-is; next event or resync will
        // recover. Surface the failure so a stuck sort+limit slice doesn't
        // silently stay stale.
        recordBootstrapError(collection, topic, err, "refetch");
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

  const unhookMutation = subscribeMutations((collection, _recordId) => {
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

  /**
   * Eager paint from the snapshot cache, BEFORE the network bootstrap
   * resolves. The mutation queue was seeded from IDB by wpb.hydrateSnapshots,
   * so queue.view / viewCollection already hold cached server records.
   *
   * Gate: only emit when the slice's view contains at least one record that
   * has a real SERVER snapshot. A replayed *pending* mutation (e.g. a stale
   * persisted SET from a prior session) composes to a non-null view but is
   * NOT cached server truth — painting it would resurrect the A11/A12 dogfood
   * oscillation (show a stale create-time body, then vanish on the replay's
   * 409). For pending-only records we fall through to today's
   * spinner/blank-then-data behavior.
   *
   * Returns true if an eager emit happened (so bootstrap can mark the slice
   * ready and skip a redundant first force-emit decision — though we still
   * deliver server-truth on revalidate via the per-consumer hash check).
   */
  function eagerEmitFromCache(slice: Slice): boolean {
    const col = slice.spec.collection;
    const topic = slice.spec.topic;

    // Representative per-consumer predicate. Every consumer on a slice shares
    // the same filter string, so any one predicate scopes the cache the same
    // way. Used to seed slice.records with only the records that belong to
    // THIS slice's filter (so reconcileGhosts can't tombstone a cached record
    // owned by a different filter).
    const predicate = slice.consumers.values().next().value?.spec.predicate;

    // Build the candidate view + the set of ids it draws from, so we can
    // confirm at least one has a server snapshot (not pending-only).
    let candidate: RawRecord[];
    if (topic !== "*") {
      const v = queue.view(col, topic);
      candidate = v ? [v] : [];
    } else if (slice.spec.sort || slice.spec.limit) {
      // Seed slice.records from the cache so materialize's top-N window has
      // something to work with before the server's getList lands.
      for (const r of queue.viewCollection(col, predicate)) {
        if (queue.hasServerSnapshot(col, r.id)) slice.records.set(r.id, r);
      }
      candidate = materialize(slice);
    } else {
      // filter-only wildcard. Seed slice.records (scoped by predicate) so
      // reconcileGhosts has a precise prior set; materialize() itself reads
      // queue.viewCollection, not slice.records.
      for (const r of queue.viewCollection(col, predicate)) {
        if (queue.hasServerSnapshot(col, r.id)) slice.records.set(r.id, r);
      }
      candidate = queue.viewCollection(col, predicate);
    }

    if (candidate.length === 0) return false;
    // At least one record must be server-backed (cached), not pending-only.
    const hasServerBacked = candidate.some((r) => queue.hasServerSnapshot(col, r.id));
    if (!hasServerBacked) return false;

    slice.ready = true;
    for (const consumer of slice.consumers) forceEmitConsumer(slice, consumer);
    return true;
  }

  /**
   * Tombstone cached/known records that vanished from a fresh fetch.
   *
   * `fresh` is the authoritative server set for this wildcard slice. The
   * prior set we reconcile against is:
   *   - sort+limit: slice.records (the server's prior top-N window, seeded
   *     from cache during eager paint).
   *   - filter-only wildcard: every record the queue currently has a SERVER
   *     snapshot for that matches the slice's filter — slice.records is a
   *     routing helper only here, so we ask the queue directly.
   * Records with a pending mutation are left alone — an optimistic write must
   * not be clobbered by a server fetch that predates it. Used by bootstrap;
   * resync has its own inline copy against slice.records (sufficient there
   * because resync always runs after a ready bootstrap seeded slice.records).
   */
  function reconcileGhosts(slice: Slice, collection: string, fresh: RawRecord[]): void {
    const seen = new Set(fresh.map((r) => r.id));
    // slice.records is the scoped prior set: sort+limit seeds it from cache
    // during eager paint, and filter-only wildcard also seeds it there (so
    // we never tombstone a cached record belonging to a *different* filter,
    // which a collection-wide scan would wrongly do).
    for (const id of Array.from(slice.records.keys())) {
      if (seen.has(id)) continue;
      if (queue.hasPending(collection, id)) continue;
      // Pre-ready-window guard: a live SSE event touched this id DURING the
      // bootstrap fetch (which predates it). A create that arrived after the
      // fetch query ran is "absent from the fresh fetch" but is NOT
      // deleted-server-side — tombstoning it would destroy the live record (and
      // persist the wrong tombstone to IDB). The touched-set discriminates a
      // genuine ghost (cached, server-deleted, untouched → still tombstoned)
      // from a live create the fetch simply couldn't see.
      if (slice.sseTouchedDuringBootstrap.has(id)) continue;
      queue.applyServer(collection, id, null);
      slice.records.delete(id);
    }
  }

  /** The initial-fetch half of bootstrap. Pure I/O + the single-record 404
   *  tombstone case; never touches the SSE listener or readiness. Extracted so
   *  bootstrap() can run it CONCURRENTLY with SSE registration (Part A). */
  async function bootstrapFetch(slice: Slice): Promise<RawRecord[]> {
    const { collection, topic, filter, sort, limit } = slice.spec;
    let initial: RawRecord[] = [];
    try {
      if (topic !== "*") {
        try {
          const r = await pb().collection(collection).getOne(topic, { $autoCancel: false });
          initial = [r as unknown as RawRecord];
        } catch (err) {
          // 404 = record doesn't exist on the server. Two sub-cases:
          //   - never existed (subscribe(id) on a missing record) → empty
          //     bootstrap, nothing to reconcile.
          //   - existed in our snapshot cache but was deleted server-side
          //     while we were offline → tombstone the cached snapshot so the
          //     eager-painted record doesn't linger. Guard on no-pending so
          //     an optimistic create-with-id isn't clobbered.
          // (Pre-cache this branch did nothing — safe only because the queue
          // was always empty here; it isn't anymore.)
          //
          // Pre-ready-window guard (Part B): a live SSE CREATE for this id may
          // have landed during the fetch (this getOne predates it). The fetch
          // is then stale-404 but the record is alive — do NOT tombstone it.
          // The touched-set records that the live listener spoke for this id.
          if ((err as { status?: number })?.status === 404) {
            if (
              queue.hasServerSnapshot(collection, topic) &&
              !queue.hasPending(collection, topic) &&
              !slice.sseTouchedDuringBootstrap.has(topic)
            ) {
              queue.applyServer(collection, topic, null);
            }
          } else {
            recordBootstrapError(collection, topic, err, "bootstrap");
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
        } catch (err) {
          recordBootstrapError(collection, topic, err, "bootstrap");
        }
      } else if (filter !== undefined) {
        try {
          const rs = await pb().collection(collection).getFullList({ filter, $autoCancel: false });
          initial = rs as unknown as RawRecord[];
        } catch (err) {
          recordBootstrapError(collection, topic, err, "bootstrap");
        }
      } else {
        // Unfiltered "*" wildcard — no canonical initial set.
        initial = [];
      }
    } catch (err) {
      // Defensive catch — the inner try/catches above should handle
      // everything. Anything reaching here is a programming error in
      // our own code, not a network failure, so log loudly.
      console.warn("[mirror] bootstrap fetch failed", { collection, topic }, err);
      recordBootstrapError(collection, topic, err, "bootstrap");
    }
    return initial;
  }

  async function bootstrap(slice: Slice): Promise<void> {
    const { collection, topic, sort, limit } = slice.spec;

    // Stale-while-revalidate: paint the snapshot cache immediately, then let
    // the network fetch below revalidate. No-op (returns false) when the
    // cache is empty for this slice — preserves today's blank-then-data.
    //
    // INTENTIONALLY runs FIRST, before any network or SSE-registration work,
    // and is deliberately NOT gated behind registration: this is the instant
    // cold-load paint the snapshot cache exists for. Gating it on a network RTT
    // (the registration POST) would undercut the whole point of the cache —
    // the user would stare at a blank screen for a round-trip even though we
    // already hold their data. Registration only gates the FRESH emit below.
    const eagerEmitted = eagerEmitFromCache(slice);

    // Yield one microtask so a SYNCHRONOUS unsubscribe() (scenarios 7, 9 —
    // watch() returns the handle and the caller tears down before bootstrap's
    // first real await) lands BEFORE we kick off SSE registration. Without this,
    // registration would fire before tornDown could be observed, wasting a
    // pb.subscribe call (and leaking/late-unsubbing a listener).
    await Promise.resolve();
    if (slice.tornDown || slice.consumers.size === 0) return;

    // Overlap registration with the fetch (Part A). The SSE subscription POST
    // and the initial getOne/getList/getFullList are independent I/O; firing
    // them concurrently hides registration latency UNDER the fetch instead of
    // adding a second RTT — preserving cold-load first-paint. We attach the
    // listener (refcount bump) NOW and await its registration below.
    //
    // LOST-PRE-REGISTRATION-EVENT RACE (why we await registration before
    // ready): PocketBase does NOT replay events broadcast before a subscription
    // is registered server-side. Pre-fix, bootstrap marked the slice ready and
    // emitted fresh state the instant the fetch resolved, while the subscribe
    // POST was still in flight — so any event published in that window (a
    // producer firing right when the consumer's initial state lands) was lost
    // forever, with no realtime update until the next resync(). Awaiting the
    // registration Promise (resolves once the POST completes + the listener is
    // live) before marking ready closes that window. Bounded by
    // SUBSCRIBE_READY_TIMEOUT_MS so a hung SSE connect can't blank the app.
    const registration = ensureCollectionListener(collection);
    slice.listenerHeld = true;

    const initial = await bootstrapFetch(slice);

    // Cancel-before-resolve: bail if all consumers gone during the fetch. The
    // listener refcount was bumped above, so release it on the way out (the
    // late unsubscribe fires once registration resolves — safeFireAndForget).
    //
    // BLOCKER 2 (double-release): a teardown DURING this await already ran
    // teardownSlice, which released the listener and cleared listenerHeld. An
    // unconditional release here would decrement the shared refcount a SECOND
    // time — for two slices sharing one collection (refcount 2) that destroys
    // the listener the SURVIVING slice still needs. Guard on listenerHeld,
    // mirroring teardownSlice, so we only ever release a handle we still hold.
    if (slice.tornDown || slice.consumers.size === 0) {
      if (slice.listenerHeld) {
        releaseCollectionListener(collection);
        slice.listenerHeld = false;
      }
      return;
    }

    // Ghost reconciliation (the cache-clobber fix). Any record we eager-
    // painted from the cache that is MISSING from the fresh fetch — and has
    // no pending mutation — was deleted server-side while we were offline.
    // Tombstone it so it doesn't linger in the post-bootstrap view.
    //
    // BLOCKER 2: reconciliation is ONLY sound for an UNLIMITED query. For a
    // filter-only wildcard (no limit), "absent from the fresh fetch" really
    // does mean "deleted server-side". For a sort+limit slice it does NOT:
    // the fetch returns only the top-N, so a cached record ranked BELOW the
    // window is absent for a reason that is indistinguishable from deletion —
    // tombstoning it would destroy a record that is still alive on the server
    // (and delete its durable IDB row). Deletion is undecidable for any
    // limited query. We skip reconciliation entirely for sort+limit: the
    // fresh refetch below REPLACES slice.records with the true top-N, and
    // materialize()'s sort+limit branch surfaces only `slice.records ∪
    // pending`, so a genuinely-deleted cached record is naturally excluded
    // after the refetch — with no false tombstones for below-window records.
    // Single-record (topic) deletion is handled inline in the getOne-404
    // branch above. So reconcile only the filter-only wildcard here.
    if (topic === "*" && !sort && !limit) {
      reconcileGhosts(slice, collection, initial);
    }

    // Seed slice.records AND the mutation queue. Seeding the queue is the
    // key to making queue.viewCollection() the single source of truth in
    // materialize() — otherwise the initial filtered set would only live
    // in slice.records and the queue overlay would be partial.
    //
    // SSE-race guard (BLOCKER 1): seed only when the queue has NO server
    // snapshot OR the snapshot it has is merely HYDRATED (from the cache).
    // A fresh fetch legitimately MUST overwrite stale hydrated data — that's
    // stale-while-revalidate, and it's what re-seeds A11/A12's record so its
    // replayed SET has real server truth underneath (the dogfood oscillation
    // fix). But it must NOT overwrite a LIVE SSE snapshot: a shared
    // per-collection listener (attached by another already-ready slice) can
    // apply a FRESHER server snapshot during THIS slice's in-flight
    // getList/getFullList await; our older fetch then resolving and
    // unconditionally calling applyServer would regress that fresher SSE
    // snapshot, and focus-driven resync doesn't reliably recover. The
    // `hydrated` provenance flag (queue.ts) distinguishes the two: applyServer
    // (SSE/ack/fetch) clears it, seedServer (hydration) sets it.
    //
    // For sort+limit, REPLACE slice.records with the fresh top-N so the window
    // is exactly the server's current top-N (the eager paint may have seeded
    // below-window records into slice.records; those stay alive in the queue —
    // we never tombstone them, per BLOCKER 2 — but they must not linger as
    // phantom window members). For filter-only wildcard, slice.records is just
    // a routing helper, so an incremental upsert is fine.
    if (sort || limit) {
      const fresh = new Map<string, RawRecord>();
      for (const r of initial) fresh.set(r.id, r);
      // Pre-ready-window guard (Part B, blocker 3): the fetch result PREDATES
      // any SSE events that landed during the bootstrap window, so for every
      // touched id the live queue.view (server+pending, already reflecting the
      // SSE event) is authoritative over whatever the fetch carried:
      //   - live create/update the fetch OMITTED → set it (don't drop it),
      //   - live update the fetch carried STALE → overwrite with the live value,
      //   - live DELETE (queue.view === null) the fetch STILL carried → remove
      //     it (don't let the stale fetch row resurrect the deleted record).
      for (const id of slice.sseTouchedDuringBootstrap) {
        const live = queue.view(collection, id);
        if (live) fresh.set(id, live);
        else fresh.delete(id);
      }
      slice.records = fresh;
    } else {
      for (const r of initial) slice.records.set(r.id, r);
    }
    //
    // ASYMMETRY (see the resync seed loop for why it differs): bootstrap GUARDS
    // its seed — it skips over a LIVE (non-hydrated) server snapshot. During a
    // bootstrap's in-flight fetch the only way the queue can already hold a live
    // snapshot for `r.id` is that an SSE event raced ahead and applied it; that
    // SSE event is NEWER than this now-stale fetch, so seeding unconditionally
    // here would reopen the stale-fetch-clobbers-fresh-SSE bug (BLOCKER 1).
    // Hydrated-from-cache snapshots DO get overwritten — that's the whole point
    // of revalidation. resync deliberately does NOT use this guard because its
    // job is the opposite: to overwrite stale-but-live snapshots on tab-resume.
    for (const r of initial) {
      // Pre-ready-window guard (Part B, blocker 2): a live SSE event for this
      // id landed during the bootstrap window (the fetch predates it). The
      // touched-set marks the live value as authoritative — the stale fetch row
      // must not re-seed over it. This covers the resurrection case directly: a
      // pre-ready DELETE ran applyServer(null), which (with no pending) drops
      // the queue entry → hasServerSnapshot is false → without this guard the
      // seed loop would re-seed the stale fetch row and resurrect the deleted
      // record. (For create/update the touched value is already the queue's
      // live snapshot, so this also avoids a redundant re-write.)
      if (slice.sseTouchedDuringBootstrap.has(r.id)) continue;
      if (!queue.hasServerSnapshot(collection, r.id) || queue.isHydrated(collection, r.id)) {
        queue.applyServer(collection, r.id, r);
      }
    }

    // The live SSE listener was attached concurrently with the fetch (above).
    // Consolidation is done; from here on, future SSE events emit directly
    // (the slice goes ready below), so the pre-ready touched-set has served its
    // purpose — clear it so it can't leak across a later resync/teardown.
    //
    // sort+limit under-fill: a pre-ready DELETE or a demoting UPDATE can leave
    // the top-N short, because the bootstrap getList fetched only the top-N.
    //   - a DELETE vacates a slot;
    //   - an UPDATE that DEMOTES a windowed row below the top-N vacates the slot
    //     it occupied — the below-window record that should promote was never
    //     fetched.
    // Neither is recoverable from `slice.records ∪ pending` alone (the promoted
    // record isn't in either), so re-query the top-N once consolidated whenever
    // windowDirtyDuringBootstrap is set (armed by the DELETE / UPDATE branches in
    // handleSseEvent; a plain CREATE never under-fills, so it doesn't arm). The
    // refetch itself drops any stale row the queue has tombstoned (see
    // scheduleRefetch), so a server commit lagging the SSE broadcast can't
    // resurrect a just-deleted row — no separate suppress list needed.
    // scheduleRefetch self-coalesces (refetchInFlight / refetchAgain), so this
    // can't double-fire with a later event-driven refetch.
    const armWindowRefetch =
      (!!sort || !!limit) && slice.windowDirtyDuringBootstrap;
    slice.windowDirtyDuringBootstrap = false;
    slice.sseTouchedDuringBootstrap.clear();
    slice.consolidated = true;

    // Await SSE registration (raced against a timeout) BEFORE marking ready, to
    // close the lost-pre-registration-event race documented above. The listener
    // was attached concurrently with the fetch, so by here its registration
    // POST has usually already resolved (overlap) — the await is then a no-op.
    // If it's still in flight we wait; if it never lands within
    // SUBSCRIBE_READY_TIMEOUT_MS we fall through to ready anyway (old behavior;
    // resync recovers any missed events). The timer is always cleared (no
    // dangling 10s timer); registration never rejects to the awaiter (mapped in
    // ensureCollectionListener), so no double-resolve / unhandledrejection.
    let regTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      registration.then(() => { if (regTimer) clearTimeout(regTimer); }),
      new Promise<void>((res) => { regTimer = setTimeout(res, SUBSCRIBE_READY_TIMEOUT_MS); }),
    ]);

    if (slice.tornDown || slice.consumers.size === 0) {
      // Cancelled while awaiting registration. Release the listener (the late
      // unsubscribe fires once registration resolves — safeFireAndForgetUnsub).
      // BLOCKER 2 (double-release): same as the post-fetch early-return above —
      // teardownSlice may have already released during this await and cleared
      // listenerHeld. Guard so we don't double-decrement a shared collection
      // refcount and kill a sibling slice's listener. Mirrors teardownSlice.
      if (slice.listenerHeld) {
        releaseCollectionListener(collection);
        slice.listenerHeld = false;
      }
      return;
    }

    slice.ready = true;

    // Deliver revalidated state to every consumer attached so far. If we
    // already eager-painted from cache, use the hash-checked deliver so an
    // identical server result doesn't double-emit (per-consumer dedup); the
    // eager paint already set each consumer's hash. With no eager paint, force
    // exactly one emit so a fresh consumer always sees initial state (even if
    // it's empty).
    for (const consumer of slice.consumers) {
      if (eagerEmitted) deliverToConsumer(slice, consumer);
      else forceEmitConsumer(slice, consumer);
    }

    // Refill a sort+limit window that a pre-ready event under-filled (delete /
    // demotion / promotion — see armWindowRefetch above). Runs AFTER the ready
    // emit so the consumer gets the consolidated state first, then the
    // re-queried top-N (which pulls in any below-window record promoted by the
    // vacated slot). scheduleRefetch drops queue-tombstoned ghosts and is
    // debounced — it won't fight a concurrent event-driven refetch.
    if (armWindowRefetch) scheduleRefetch(slice);
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
        consolidated: false,
        perConsumerHash: new WeakMap(),
        listenerHeld: false,
        refetchInFlight: null,
        refetchAgain: false,
        tornDown: false,
        windowDirtyDuringBootstrap: false,
        pendingWindowTombstones: new Set(),
        sseTouchedDuringBootstrap: new Set(),
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

  async function resync(opts?: { force?: boolean }): Promise<void> {
    // Coalesce: a backstop (focus/visibility) resync landing within the window
    // of the last one is redundant — skip it. The reconnect path passes
    // { force: true } to BYPASS the window (see RESYNC_COALESCE_MS): it's the
    // authoritative drop+reconnect signal and must always fetch, even when a
    // focus-on-resume just stamped lastResyncAt. Both paths re-stamp the time
    // so a later trailing trigger coalesces. Self-healing either way.
    const now = Date.now();
    if (!opts?.force && now - lastResyncAt < RESYNC_COALESCE_MS) return;
    lastResyncAt = now;
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
              if ((err as { status?: number })?.status === 404) {
                fresh = [];
              } else {
                recordBootstrapError(collection, topic, err, "resync");
                return;
              }
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
        } catch (err) {
          recordBootstrapError(collection, topic, err, "resync");
          return;
        }

        if (slice.tornDown || slice.consumers.size === 0) return;

        // Reconcile: anything in the prior set that's MISSING from the refresh
        // and has no pending mutation → deleted server-side during the
        // disconnect window. Apply a queue tombstone so queue.viewCollection
        // drops them.
        const next = new Map<string, RawRecord>();
        for (const r of fresh) next.set(r.id, r);
        const seen = new Set(next.keys());
        // The prior set to reconcile against. slice.records.keys() is NOT
        // sufficient for the shapes whose materialize() reads the QUEUE rather
        // than slice.records: a record can be SERVER-BACKED in the queue yet
        // absent from slice.records. The classic case is an optimistic create
        // that ACKED while the SSE was suspended — the write succeeded (queue has
        // a server snapshot from the ack) but its echo was lost, so
        // handleSseEvent never ran and never put it in slice.records. If it's
        // later server-deleted (also unseen over the dead SSE), the fetch omits
        // it but the slice.records-only scan never tombstones it → it ghosts in
        // the view forever. So include the queue's server-backed records in the
        // reconcile set for those shapes:
        //   - filter-only wildcard: materialize reads queue.viewCollection, so
        //     scan every queue record matching this slice's predicate.
        //   - single (topic=id): materialize reads queue.view(col, topic), so the
        //     one relevant id is `topic` itself.
        // sort+limit is excluded: materialize reads slice.records (the top-N
        // window), which the refetch REPLACES with the true top-N — a below-window
        // record absent from the top-N fetch must NOT be tombstoned (BLOCKER 2).
        //
        // CRITICAL: gate each queue candidate on hasServerSnapshot && !hasPending
        // (mirroring the slice.records pending guard). An optimistic-only pending
        // create (no server snapshot) legitimately isn't in the fetch yet —
        // tombstoning it would destroy an in-flight write. The gate is exactly
        // what protects it.
        const reconcileIds = new Set<string>(slice.records.keys());
        if (topic === "*" && !sort && !limit) {
          const predicate = slice.consumers.values().next().value?.spec.predicate;
          for (const r of queue.viewCollection(collection, predicate)) {
            if (
              queue.hasServerSnapshot(collection, r.id) &&
              !queue.hasPending(collection, r.id)
            ) {
              reconcileIds.add(r.id);
            }
          }
        } else if (topic !== "*") {
          if (
            queue.hasServerSnapshot(collection, topic) &&
            !queue.hasPending(collection, topic)
          ) {
            reconcileIds.add(topic);
          }
        }
        for (const oldId of reconcileIds) {
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
        //
        // ASYMMETRY (see the bootstrap seed loop for why it differs): resync
        // seeds UNCONDITIONALLY — it deliberately does NOT use bootstrap's
        // "skip over a live snapshot" guard. resync is the latest-server-truth-
        // wins convergence mechanism that runs on tab-resume to catch events
        // missed while the SSE was down (PocketBase realtime does NOT replay
        // missed events). Its entire job is to overwrite stale-but-"live"
        // (non-hydrated) snapshots; applying bootstrap's guard would make resync
        // skip exactly the records it exists to refresh, breaking multi-device
        // catch-up. The narrow in-flight SSE-race the guard protects bootstrap
        // from is acceptable here because resync re-runs on the next
        // focus/reconnect and self-heals.
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
    // Tear down the reconnect→resync hook. Restore the prior onDisconnect ONLY
    // if we're still the installed handler — with two mirrors chained on one pb
    // (M2→M1→orig), a blind restore would clobber a handler installed after us.
    // If someone installed after us, leave the slot alone: their dispose will
    // restore to OUR handler, which is post-dispose-inert (the `disposed` guard
    // short-circuits it). Unsubscribe PB_CONNECT via the async-safe helper (its
    // DELETE /api/realtime can 404 when the channel is already gone).
    if (realtimeHooked) {
      try {
        const rt = (pb().realtime as unknown) as { onDisconnect?: unknown } | undefined;
        if (rt && rt.onDisconnect === ourOnDisconnect) rt.onDisconnect = prevOnDisconnect;
      } catch { /* SDK without realtime — nothing to restore */ }
      if (pbConnectUnsub) safeFireAndForgetUnsub(pbConnectUnsub);
      pbConnectUnsub = null;
      realtimeHooked = false;
    }
    // Drain any remaining listeners (should be none if teardownSlice did
    // its job, but be defensive).
    for (const collection of Array.from(listeners.keys())) {
      const l = listeners.get(collection);
      if (!l) continue;
      l.refcount = 0;
      const pending = l.unsub;
      l.unsub = null;
      listeners.delete(collection);
      if (pending) safeFireAndForgetUnsub(pending);
    }
  }

  return { watch, watchCombined, resync, dispose };
}
