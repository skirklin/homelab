/**
 * Optimistic-write wrapper around PocketBase.
 *
 * Mirrors Firestore's mutation-queue + server-snapshot model. Writes push
 * onto a per-record queue; the network call fires in the background. PBMirror
 * (mirror.ts) is the sole live-state consumer — it subscribes to the raw
 * PocketBase realtime channel, drives `applyServer`, and hooks the
 * `subscribeMutations` callback so optimistic writes flow into its slices.
 *
 * Persistence: pending mutations are written to IndexedDB before dispatch and
 * cleared on ack/reject. A reload mid-flight replays them on next session.
 * Replay is safe because creates use client-supplied IDs (idempotent), updates
 * are last-write-wins patches, and deletes treat 404 as success.
 */
import type PocketBase from "pocketbase";
import type { RecordModel, RecordOptions, RecordListOptions, RecordFullListOptions, ListResult } from "pocketbase";
import { newId } from "./ids";
import { MutationQueue, HYDRATED_SEQ, type Mutation, type RawRecord } from "./queue";
import { persistMutation, unpersistMutation, loadAllMutations } from "./persistence";
import {
  persistSnapshots,
  deleteSnapshots,
  loadSnapshotsForUser,
  clearAllSnapshots,
  pruneSnapshotsOlderThan,
  snapshotKey,
  type PersistedSnapshot,
} from "./snapshot-persistence";

export { MutationQueue, composeView, HYDRATED_SEQ, type Mutation, type RawRecord, type PendingMutation } from "./queue";
export { type PersistedMutation, persistMutation, loadAllMutations, clearAllMutations } from "./persistence";
export {
  type PersistedSnapshot,
  persistSnapshots,
  deleteSnapshots,
  loadSnapshotsForUser,
  clearAllSnapshots,
  pruneSnapshotsOlderThan,
} from "./snapshot-persistence";
export { newId } from "./ids";
export { createMirror, type PBMirror, type WatchSpec, type WatchHandle } from "./mirror";

/** How long a cached snapshot survives across cold loads before age-eviction
 *  drops it on the next hydrate. Stale rows just cost one revalidation fetch,
 *  so this is generous. */
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Debounce window for the batched snapshot writer. Coalesces a bootstrap's
 *  burst of applyServer calls into one IDB transaction. */
const SNAPSHOT_FLUSH_MS = 250;

// ---- Types ----

/**
 * Error thrown by the wrapper when an optimistic write is rejected by PB.
 * Carries the operation context so a global `unhandledrejection` handler
 * can show a meaningful toast for un-awaited write failures.
 */
export class WrappedPbError extends Error {
  readonly op: { kind: "create" | "update" | "delete"; collection: string; recordId: string };
  readonly originalError: unknown;

  constructor(op: WrappedPbError["op"], originalError: unknown) {
    const message = (() => {
      if (originalError && typeof originalError === "object") {
        const msg = (originalError as { message?: unknown }).message;
        if (typeof msg === "string") return msg;
      }
      return "Optimistic write rejected";
    })();
    super(message);
    this.name = "WrappedPbError";
    this.op = op;
    this.originalError = originalError;
  }
}

export interface WrappedCollection {
  // Network reads — passthrough straight to PB (no queue overlay). Live state
  // goes through PBMirror; these exist for one-shot lookups (e.g.
  // read-modify-write of a JSON column).
  getFullList<T = RecordModel>(opts?: RecordFullListOptions): Promise<T[]>;
  getFullList<T = RecordModel>(batch?: number, opts?: RecordListOptions): Promise<T[]>;
  getList<T = RecordModel>(page?: number, perPage?: number, opts?: RecordListOptions): Promise<ListResult<T>>;
  getFirstListItem<T = RecordModel>(filter: string, opts?: RecordListOptions): Promise<T>;
  getOne<T = RecordModel>(id: string, opts?: RecordOptions): Promise<T>;
  // In-memory reads — NOT passthrough. These read the queue overlay
  // synchronously (server snapshot + pending optimistic mutations), so they
  // reflect un-acked local writes and never touch the network.
  /** Synchronous in-memory read (server snapshot + pending overlay). Returns null if not cached. */
  view<T = RecordModel>(id: string): T | null;
  /** Synchronous scan of all cached records (server + pending) matching predicate. */
  viewCollection<T = RecordModel>(predicate?: (r: T) => boolean): T[];
  // Optimistic writes — return Promise<server record> resolved on ack.
  create<T = RecordModel>(body: Record<string, unknown>, opts?: RecordOptions): Promise<T>;
  update<T = RecordModel>(id: string, body: Record<string, unknown>, opts?: RecordOptions): Promise<T>;
  delete(id: string, opts?: RecordOptions): Promise<boolean>;
}

export interface WrappedPocketBase {
  collection(name: string): WrappedCollection;
  /** Triggers persisted-mutation replay. Idempotent. Call once after auth is ready. */
  replayPending(): Promise<void>;
  /**
   * Hydrate the mutation queue with the current user's persisted server
   * snapshots so a cold load can paint cached data before any network fetch
   * resolves (stale-while-revalidate). No-op when unauthenticated. Idempotent;
   * BackendProvider awaits it (race-capped) before rendering.
   */
  hydrateSnapshots(): Promise<void>;
  /**
   * Force-flush the pending snapshot-cache writes NOW (cancel the debounce
   * timer and write the dirty map immediately). Wired to pagehide /
   * visibilitychange→hidden in BackendProvider so the last ~250ms of cached
   * server state isn't lost when the tab closes mid-debounce. Cheap and a
   * no-op when nothing is dirty or IndexedDB is absent.
   */
  flushSnapshots(): Promise<void>;
  /**
   * Re-fire every mutation whose dispatch failed transiently (network
   * blip, 5xx, 429, etc.). Wired internally to PB_CONNECT; BackendProvider
   * also calls it on focus/visibilitychange so phones picking back up
   * drain queued writes without the user having to retry by hand. No-op
   * when there are no errored writes.
   */
  retryErrored(): Promise<void>;
  /**
   * Observability handle: ring-buffered event log + live snapshot. Exists so
   * the next "Angela's phone didn't see the update" or "my writes vanished
   * after a cache clear" report can be diagnosed from real data instead of
   * theories. Auto-exposed on `window.__wpbDebug` in browsers — open the
   * console and run `__wpbDebug.snapshot()` or `__wpbDebug.events()`.
   */
  debug: WpbDebug;
  /**
   * Mirror integration surface — for PBMirror's exclusive use.
   *
   * `queue` exposes the MutationQueue so the mirror can materialize slice
   * views (queue.view / queue.viewCollection) and seed it from initial
   * fetches via applyServer. `subscribeMutations(cb)` registers a callback
   * fired whenever wpb pushes, drains, or applies a mutation, so the
   * mirror can re-emit affected slices.
   *
   * Domain backends should not touch these — they write through
   * `collection(...).create/update/delete` and read live state via the
   * mirror's `watch`. Direct queue access from app code would bypass the
   * mirror's filtering / sort+limit / per-consumer hashing layer.
   */
  mirrorIntegration: WpbMirrorIntegration;
}

/** Internal surface PBMirror grabs at construction. Not for general use. */
export interface WpbMirrorIntegration {
  queue: MutationQueue;
  subscribeMutations(cb: (collection: string, recordId: string) => void): () => void;
}

/** Kinds of internal events recorded for post-hoc debugging. */
export type WpbEventKind =
  | "mutation-push"     // wpb pushed a pending mutation to the queue
  | "mutation-ack"      // server confirmed a mutation
  | "mutation-error"    // server rejected a mutation
  | "replay"            // replayPending re-fired a persisted mutation
  | "retry-batch"       // retryErrored() began a sweep of queued failed writes
  | "bootstrap-error";  // mirror bootstrap fetch failed for a slice

export interface WpbEvent {
  t: number; // ms since epoch
  kind: WpbEventKind;
  collection?: string;
  recordId?: string;
  detail?: Record<string, unknown>;
}

export interface WpbCollectionSnapshot {
  /** All pending mutations for this collection (in-flight + errored). */
  pendingMutations: number;
  /** Subset of pendingMutations that have failed at least once and are
   *  waiting on retryErrored() (PB_CONNECT or focus) to re-fire. */
  erroredMutations: number;
  /** Oldest pending mutation's createdAt (ms epoch), null if none. */
  oldestPendingAt: number | null;
  /** Oldest errored mutation's first-error timestamp (ms epoch), null if
   *  no errored mutations in this collection. */
  oldestErroredAt: number | null;
}

export interface WpbSnapshot {
  totalPending: number;
  totalErrored: number;
  oldestPendingAt: number | null;
  oldestErroredAt: number | null;
  collections: Record<string, WpbCollectionSnapshot>;
}

export interface WpbDebug {
  /** Read-only view of the most recent N events (newest last). */
  events(): readonly WpbEvent[];
  /** Live snapshot of pending writes. */
  snapshot(): WpbSnapshot;
  /** Drop the in-memory ring buffer. Does not touch persisted mutations. */
  clear(): void;
  /**
   * Append an event to the ring buffer from outside wpb. PBMirror uses
   * this to surface bootstrap failures so SyncDot / __wpbDebug see one
   * unified feed instead of having to query a separate mirror surface.
   * The timestamp is filled in automatically.
   */
  recordEvent(ev: Omit<WpbEvent, "t">): void;
}

/** Cap on the ring buffer — enough to cover a few minutes of activity, small
 *  enough that the memory footprint and stringify cost is irrelevant. */
const DEBUG_RING_CAPACITY = 200;

// ---- Implementation ----

export function wrapPocketBase(pb: () => PocketBase): WrappedPocketBase {
  const origin = newId(); // session id for this wrapper instance

  /**
   * Persistent server-snapshot cache writer.
   *
   * Every server-state change funnels through queue.applyServer →
   * onServerChange (below). We accumulate dirty (collection,id)→snapshot in a
   * Map and flush on a short debounce, splitting puts from deletes, stamping
   * the authed user, and writing one IDB transaction. Anonymous sessions skip
   * persistence entirely (no user to scope by). Guarded for the Node case
   * where indexedDB is absent — the persist* helpers themselves swallow, but
   * we skip the timer churn too.
   *
   * `hydrating` suppresses the writer during hydrateSnapshots so loading the
   * cache back in doesn't loop straight out to IDB. (Hydration seeds via
   * applyServer at HYDRATED_SEQ, which doesn't fire onServerChange — this flag
   * is a belt-and-suspenders for any real applyServer path that runs
   * concurrently.)
   */
  // Each dirty entry stamps the user CAPTURED AT QUEUE TIME (when applyServer
  // fired), NOT at flush time. Reading authStore at flush time (~250ms later)
  // races an auth flip in the debounce window: user A's queued snapshot would
  // get stamped user B and land in B's scope (B's next hydrate reads A's data).
  // Capturing here pins the row to the user who actually owned the read.
  const dirtySnapshots = new Map<string, { collection: string; id: string; snapshot: RawRecord | null; user: string | null }>();
  let snapshotFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let hydrating = false;

  async function flushSnapshots(): Promise<void> {
    if (snapshotFlushTimer !== null) {
      clearTimeout(snapshotFlushTimer);
      snapshotFlushTimer = null;
    }
    if (dirtySnapshots.size === 0) return;
    const batch = Array.from(dirtySnapshots.values());
    dirtySnapshots.clear();
    // Group puts/deletes by the user CAPTURED AT QUEUE TIME so a mid-window
    // auth flip can't mis-scope any row. Anonymous reads (null/empty user) are
    // never cached — drop them.
    const putsByUser = new Map<string, PersistedSnapshot[]>();
    const deletes: string[] = [];
    const now = Date.now();
    for (const { collection, id, snapshot, user } of batch) {
      if (!user) continue; // anonymous — nothing to scope a cache row by.
      const key = snapshotKey(user, collection, id);
      if (snapshot === null) {
        deletes.push(key);
      } else {
        const arr = putsByUser.get(user) ?? [];
        arr.push({ key, user, collection, id, record: snapshot, updatedAt: now });
        putsByUser.set(user, arr);
      }
    }
    // Await the IDB writes so the public force-flush (pagehide) actually lands
    // before the tab is frozen. The timer path ignores the returned promise.
    await Promise.all([
      ...Array.from(putsByUser.values()).map((puts) => persistSnapshots(puts)),
      deleteSnapshots(deletes),
    ]);
  }

  function onServerChange(collection: string, id: string, snapshot: RawRecord | null): void {
    // Structural guarantee: a snapshot cannot reach IDB without the sign-out
    // clear-hook being live, independent of BackendProvider's render order.
    // Every persisted snapshot flows through exactly this chokepoint (applyServer
    // → onServerChange; HYDRATED_SEQ hydration deliberately does NOT fire it), so
    // arming hookAuthChange as the FIRST statement here makes it impossible to
    // queue a row for persistence before the clear-hook is installed. hydrate()
    // also arms it (belt-and-suspenders for empty-cache read-only sessions that
    // never persist) — see the hookAuthChange call in hydrateSnapshots. By the
    // time any real applyServer fires the backend is initialized, so pb() is
    // safe; hookAuthChange is idempotent (early-returns once installed).
    hookAuthChange();
    if (hydrating) return;
    if (typeof indexedDB === "undefined") return;
    // Stamp the user NOW (queue time), not at flush — see dirtySnapshots above.
    const user = pb().authStore?.record?.id ?? null;
    // Key is (collection, id) WITHOUT user (the user rides in the value). So if
    // a different user writes the same (col, id) within the debounce window, the
    // later write coalesces last-writer-wins onto the earlier one. That's safe:
    // each surviving entry still carries its OWN captured user, so nothing lands
    // in the wrong scope — at worst the dropped row is simply absent from the
    // cache and self-heals on that user's next revalidate fetch.
    dirtySnapshots.set(`${collection}::${id}`, { collection, id, snapshot, user });
    if (snapshotFlushTimer === null) {
      snapshotFlushTimer = setTimeout(flushSnapshots, SNAPSHOT_FLUSH_MS);
    }
  }

  const queue = new MutationQueue({ onServerChange });
  /**
   * Hook listeners for "any mutation was pushed/drained/applied". PBMirror
   * uses this to re-emit slices when an optimistic write lands or is rolled
   * back.
   */
  const mutationListeners = new Set<(collection: string, recordId: string) => void>();
  function notifyMutationListeners(collection: string, recordId: string): void {
    for (const cb of mutationListeners) {
      try { cb(collection, recordId); } catch (err) { console.error("[wpb] mutation listener threw", err); }
    }
  }
  /** Ring buffer of recent internal events for debugging. */
  const debugRing: WpbEvent[] = [];
  function recordEvent(ev: Omit<WpbEvent, "t">) {
    debugRing.push({ t: Date.now(), ...ev });
    if (debugRing.length > DEBUG_RING_CAPACITY) debugRing.shift();
  }

  /**
   * Mutations whose dispatch failed transiently and are awaiting retry.
   * The optimistic queue entry stays — UI shows the pending state — and
   * retryErrored() re-fires each on PB_CONNECT/focus. Keyed by mutationId.
   *
   * Persistence is separate (IndexedDB), so even a page reload preserves
   * the queue; on the next mount replayPending re-dispatches, the same
   * classifier runs, and transient failures end up back in this map.
   */
  interface ErroredEntry {
    collection: string;
    recordId: string;
    mutationId: string;
    kind: "create" | "update" | "delete";
    errorAt: number;
    attempts: number;
    lastStatus?: number;
    lastMessage?: string;
  }
  const errored = new Map<string, ErroredEntry>();

  /** Idempotency guard for the PB_CONNECT subscription. */
  let realtimeHooked = false;

  /**
   * Auth-identity tracking for realtime reset on user switch.
   *
   * PocketBase's realtime channel ties a `clientId` to the auth that
   * originally connected. If `authStore.save()` swaps in a different
   * user's token while the SSE stream is still open, the next
   * `/api/realtime` POST (e.g. a new `subscribe()`) ships the new auth
   * header against the old clientId, and PB rejects it with
   * `403: The current and the previous request authorization don't match`.
   *
   * The PB SDK itself does NOT react to auth changes on realtime — only on
   * the auto-refresh path. So we explicitly hook authStore.onChange and
   * disconnect the realtime channel on user-identity flips. Next
   * `subscribe()` will trigger `connect()` and pick up a fresh clientId
   * bound to the new auth.
   *
   * Triggers on:
   *   - record.id changes (user A → user B, or sign-in from anon)
   *   - token cleared (sign-out)
   *
   * No-op on token rotation for the same user (the common refresh case).
   *
   * Installed EAGERLY from `hydrateSnapshots` (the read-only entrypoint every
   * session hits on mount), not lazily on first write. A read-only session —
   * one that hydrates the cache and watches slices but never issues a write —
   * must still install the sign-out/user-switch clear, or one user's cached
   * data lingers in IDB after the next user signs in on the same device.
   * `hookRealtimeLifecycle` (first write) also calls it as a backstop.
   * Idempotent (guarded by `authChangeUnsub`); a stub without `onChange` is a
   * no-op.
   */
  let lastAuthRecordId: string | null = null;
  let authChangeUnsub: (() => void) | null = null;
  function hookAuthChange() {
    if (authChangeUnsub) return;
    const client = pb();
    const store = client.authStore as unknown as {
      record?: { id?: string } | null;
      onChange?: (cb: (token: string, record: { id?: string } | null) => void) => () => void;
    } | undefined;
    if (!store || typeof store.onChange !== "function") return;
    lastAuthRecordId = store.record?.id ?? null;
    authChangeUnsub = store.onChange((_token, record) => {
      const nextId = record?.id ?? null;
      if (nextId === lastAuthRecordId) return;
      lastAuthRecordId = nextId;
      // Identity changed (sign-out → null, or switch to a different user).
      // Order the clear w.r.t. the snapshot writer: SYNCHRONOUSLY cancel the
      // pending debounce timer and empty the dirty map FIRST, so no in-flight
      // flush can repopulate the store AFTER clearAllSnapshots() runs (IDB txns
      // are unordered — a late put racing the clear would leave a stray row).
      if (snapshotFlushTimer !== null) {
        clearTimeout(snapshotFlushTimer);
        snapshotFlushTimer = null;
      }
      dirtySnapshots.clear();
      // Drop every cached snapshot at rest: per-user hydrate already prevents
      // cross-user READS, but we don't leave one user's data sitting in IDB
      // after a logout/switch. Defense-in-depth. Fire-and-forget (.catch via
      // the helper's internal swallow).
      void clearAllSnapshots();
      // Identity changed — tear down realtime so the next subscribe gets
      // a fresh clientId bound to the new auth.
      try {
        // PB SDK marks RealtimeService.disconnect as private, but it's
        // exposed on the runtime object. We need it for the auth-switch
        // reset (private methods are an SDK packaging detail, not an API
        // contract). Cast through unknown to bypass the TS visibility
        // check rather than calling an internal-shaped helper.
        const rt = (client.realtime as unknown) as { disconnect?: () => void } | undefined;
        rt?.disconnect?.();
      } catch {
        /* SDK without realtime / disconnect — nothing to do */
      }
      // The PB_CONNECT subscription we registered via hookRealtimeLifecycle
      // is still in the SDK's subscription map. After disconnect, the next
      // pb.realtime.subscribe will reconnect and re-register everything
      // (including PB_CONNECT) with the new clientId. We do NOT clear
      // realtimeHooked: the listener is still installed, just temporarily
      // dormant until the next subscribe.
    });
  }

  /**
   * Subscribe to PB_CONNECT so transient write failures get retried the moment
   * realtime reconnects — they likely failed because the network was down,
   * and now isn't. Hooked lazily on the first write so test stubs that
   * never touch realtime aren't forced to define a PB_CONNECT handler.
   *
   * Wrapped in try/catch because the PB SDK's RealtimeService.subscribe
   * synchronously constructs `new EventSource(...)`, which throws a
   * ReferenceError in Node-side e2e tests that drive writes without
   * subscribing. retryErrored stays callable directly; production browsers
   * always have EventSource, so the guard is free in prod and a no-op for
   * tests.
   */
  function hookRealtimeLifecycle() {
    // Auth-change handler is independent of the PB_CONNECT subscription,
    // but they're hooked at the same site (first realtime touch) so it's
    // exactly one call per wpb session. Idempotent inside.
    hookAuthChange();
    if (realtimeHooked) return;
    const client = pb();
    if (!client.realtime) return;
    realtimeHooked = true;
    try {
      const sub = client.realtime.subscribe("PB_CONNECT", () => {
        // Cheap when the errored map is empty (early return inside).
        void retryErrored();
      });
      // The PB SDK's subscribe returns a Promise; catch both the sync
      // construction failure (handled above) and any async open failure
      // (CORS preflight, auth blip, etc.).
      if (sub && typeof (sub as Promise<unknown>).catch === "function") {
        (sub as Promise<unknown>).catch(() => { realtimeHooked = false; });
      }
    } catch {
      // EventSource unavailable (Node) — stay un-hooked. Production code
      // can still call retryErrored() directly on focus/visibility.
      realtimeHooked = false;
    }
  }

  function synthesizeRecord(
    collection: string,
    body: Record<string, unknown>,
    id: string,
  ): RawRecord {
    const now = new Date().toISOString();
    return {
      id,
      collectionId: "",
      collectionName: collection,
      created: now,
      updated: now,
      ...body,
    };
  }

  /**
   * Build the network call for a given mutation. Centralized so the retry /
   * replay paths reconstruct the request without duplicating the kind-switching
   * logic.
   *
   * NOT identical to the initial dispatch: the inline create/update/delete
   * closures (in the WrappedCollection methods below) forward the caller's
   * `opts`, but the retry/replay path here deliberately omits them. `opts` is
   * request-scoped — its main payload is the caller's `requestKey` (the
   * PB-autocancel-on-concurrent-writes guard), which is meaningful only for the
   * one in-flight request the caller issued. A retry or a cold replay is a new
   * request with no live sibling to dedupe against, so reusing the original
   * requestKey would be wrong (it could autocancel an unrelated in-flight
   * write). Replaying body-only is the intended behavior, not an oversight.
   */
  function fireMutation(collection: string, recordId: string, mutation: Mutation): () => Promise<RawRecord | null> {
    return async () => {
      if (mutation.kind === "set") {
        const { id: _id, ...body } = mutation.record;
        const r = await pb().collection(collection).create({ ...body, id: recordId });
        return r as RawRecord;
      } else if (mutation.kind === "update") {
        const r = await pb().collection(collection).update(recordId, mutation.patch);
        return r as RawRecord;
      } else {
        await pb().collection(collection).delete(recordId);
        return null;
      }
    };
  }

  /**
   * Per-record dispatch chain. Mutations on the same record id are
   * serialized so PB sees them in the order the user issued them. This
   * matters most after `replayPending`: a persisted-create's POST may
   * still be in flight when the user clicks an update on the visible
   * (optimistic) row. Without serialization, the update POST races ahead
   * and hits PB before the create lands → 404 on update → WrappedPbError.
   *
   * Serialization is per (collection, recordId). Cross-record concurrency
   * is unchanged. The chain's promise always resolves (never rejects) so
   * the next link can run regardless of how the prior one settled.
   */
  const dispatchChains = new Map<string, Promise<unknown>>();

  function dispatchMutation(
    collection: string,
    recordId: string,
    mutationId: string,
    fire: () => Promise<RawRecord | null>,
    kind: "create" | "update" | "delete",
  ): Promise<RawRecord | null> {
    const chainKey = `${collection}::${recordId}`;
    const prev = dispatchChains.get(chainKey) ?? Promise.resolve();
    const outcome = (async () => {
      // Wait for any prior dispatch on this record. Use .catch so a
      // prior permanent-rejection doesn't poison us — we still want to
      // fire our own attempt; PB will validate independently.
      try {
        await prev;
      } catch { /* prior chain settled with rejection; that's their problem */ }
      return runOne();
    })();
    // Track the latest chain head. Convert outcome to never-reject before
    // storing in the map so a subsequent `await prev` doesn't blow up.
    const chainLink: Promise<unknown> = outcome.catch(() => {});
    dispatchChains.set(chainKey, chainLink);
    void chainLink.then(() => {
      // Delete only if I'm STILL the tail. A newer mutation enqueued while this
      // one ran will have overwritten the map entry to chain off us; clearing it
      // unconditionally would orphan that successor (it'd start a fresh chain and
      // race the in-flight write). Same "mutate only if still on top" discipline
      // as mirror.ts's restore-only-if-on-top.
      if (dispatchChains.get(chainKey) === chainLink) dispatchChains.delete(chainKey);
    });
    return outcome;

    async function runOne(): Promise<RawRecord | null> {
    try {
      const result = await fire();
      // Apply server snapshot from the ack response, then drain pending.
      queue.applyServer(collection, recordId, result);
      queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      errored.delete(mutationId);
      recordEvent({ kind: "mutation-ack", collection, recordId, detail: { mutationId, op: kind } });
      notifyMutationListeners(collection, recordId);
      return result;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const message = (err as { message?: string })?.message;
      const transient = isTransientWriteError(err);

      if (transient) {
        // Keep the mutation in the queue and IndexedDB. The optimistic UI
        // stays — the caller's await resolves with the synthesized record
        // via wpb.create/update's `(ack ?? record)` fallback, matching
        // Firebase's offline-write semantics. retryErrored() re-fires on
        // PB_CONNECT / focus, so a network blip no longer eats the write.
        const prior = errored.get(mutationId);
        errored.set(mutationId, {
          collection,
          recordId,
          mutationId,
          kind,
          errorAt: Date.now(),
          attempts: (prior?.attempts ?? 0) + 1,
          lastStatus: status,
          lastMessage: message,
        });
        recordEvent({
          kind: "mutation-error",
          collection,
          recordId,
          detail: { mutationId, op: kind, status, message, transient: true, attempts: (prior?.attempts ?? 0) + 1 },
        });
        // Don't throw — caller's await resolves so the UI continues
        // without alarming the user about a network blip that will
        // likely auto-recover.
        return null;
      }

      // Permanent error: drain, drop persisted copy, notify mirror, throw.
      queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      errored.delete(mutationId);
      recordEvent({
        kind: "mutation-error",
        collection,
        recordId,
        detail: { mutationId, op: kind, status, message, transient: false },
      });
      notifyMutationListeners(collection, recordId);
      throw new WrappedPbError({ kind, collection, recordId }, err);
    }
    }
  }

  function makeCollection(name: string): WrappedCollection {
    return {
      // Reads — pure passthrough.
      getFullList<T>(...args: unknown[]) {
        const c = pb().collection(name) as unknown as { getFullList: (...a: unknown[]) => Promise<T[]> };
        return c.getFullList(...args);
      },
      getList<T = RecordModel>(page?: number, perPage?: number, opts?: RecordListOptions) {
        return pb().collection(name).getList<T>(page, perPage, opts);
      },
      getFirstListItem<T = RecordModel>(filter: string, opts?: RecordListOptions) {
        return pb().collection(name).getFirstListItem<T>(filter, opts);
      },
      getOne<T = RecordModel>(id: string, opts?: RecordOptions) {
        return pb().collection(name).getOne<T>(id, opts);
      },
      view<T = RecordModel>(id: string): T | null {
        return queue.view(name, id) as T | null;
      },
      viewCollection<T = RecordModel>(predicate?: (r: T) => boolean): T[] {
        return queue.viewCollection(name, predicate as ((r: RawRecord) => boolean) | undefined) as T[];
      },

      // Optimistic create. Mirror listeners see the create via the mutation
      // hook synchronously; persistence is fire-and-forget (non-blocking).
      async create<T = RecordModel>(body: Record<string, unknown>, opts?: RecordOptions): Promise<T> {
        hookRealtimeLifecycle();
        const id = (body.id as string) || newId();
        const record = synthesizeRecord(name, { ...body, id }, id);
        const mutationId = newId();
        const mutation: Mutation = { kind: "set", record };

        queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "create" } });
        notifyMutationListeners(name, id);
        void persistMutation({
          id: mutationId,
          collection: name,
          recordId: id,
          mutation,
          createdAt: Date.now(),
          origin,
        });

        const ack = await dispatchMutation(name, id, mutationId, async () => {
          const r = await pb().collection(name).create({ ...body, id }, opts);
          return r as RawRecord;
        }, "create");
        return (ack ?? record) as T;
      },

      // Optimistic update.
      async update<T = RecordModel>(id: string, body: Record<string, unknown>, opts?: RecordOptions): Promise<T> {
        hookRealtimeLifecycle();
        const mutationId = newId();
        const mutation: Mutation = { kind: "update", patch: body };

        const { after } = queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "update" } });
        notifyMutationListeners(name, id);
        void persistMutation({
          id: mutationId,
          collection: name,
          recordId: id,
          mutation,
          createdAt: Date.now(),
          origin,
        });

        const ack = await dispatchMutation(name, id, mutationId, async () => {
          const r = await pb().collection(name).update(id, body, opts);
          return r as RawRecord;
        }, "update");
        return (ack ?? after) as T;
      },

      // Optimistic delete.
      async delete(id: string, opts?: RecordOptions): Promise<boolean> {
        hookRealtimeLifecycle();
        const mutationId = newId();
        const mutation: Mutation = { kind: "delete" };

        queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "delete" } });
        notifyMutationListeners(name, id);
        void persistMutation({
          id: mutationId,
          collection: name,
          recordId: id,
          mutation,
          createdAt: Date.now(),
          origin,
        });

        await dispatchMutation(name, id, mutationId, async () => {
          await pb().collection(name).delete(id, opts);
          return null;
        }, "delete");
        return true;
      },
    };
  }

  /**
   * Walk every errored mutation and re-fire its dispatch. Wired to
   * PB_CONNECT and (via BackendProvider) focus/visibilitychange so that
   * "writes queued during a network blip" land automatically when
   * conditions improve. No-op when there are no errored writes — cheap to
   * call on every wake-up.
   */
  async function retryErrored(): Promise<void> {
    if (errored.size === 0) return;
    // Snapshot the keys up front: dispatchMutation will mutate `errored`
    // as it runs (success removes, repeat failure re-adds with bumped
    // attempts), and iterating a Map while it's being mutated is awkward.
    const entries = Array.from(errored.values());
    recordEvent({ kind: "retry-batch", detail: { count: entries.length } });
    for (const entry of entries) {
      // The mutation must still be in the queue — transient errors keep
      // it there intentionally. If it's gone, the entry is stale (e.g.,
      // explicit drain elsewhere), so just drop the errored marker.
      const pending = queue.allPending().find((p) => p.id === entry.mutationId);
      if (!pending) {
        errored.delete(entry.mutationId);
        continue;
      }
      // Leave the errored entry in place — dispatchMutation reads
      // prior?.attempts to bump the counter on continued failure, and
      // removes the entry on success. Pre-deleting here would reset the
      // attempts count and lose retry history.
      void dispatchMutation(
        entry.collection,
        entry.recordId,
        entry.mutationId,
        fireMutation(entry.collection, entry.recordId, pending.mutation),
        entry.kind,
      ).catch((err) => {
        // Permanent error path already drained + logged; transient path
        // re-armed errored map. Either way nothing for us to do here, but
        // we swallow the rejection so the void doesn't escalate to
        // unhandledrejection (the user-facing toast handler is bound to
        // the original caller's awaited dispatch, not the retry).
        void err;
      });
    }
  }

  return {
    collection: makeCollection,
    retryErrored,
    flushSnapshots,
    async hydrateSnapshots() {
      // Install the auth-change clear hook EAGERLY here (not lazily on first
      // write) so a read-only session — one that hydrates + watches but never
      // writes — still clears cached data on sign-out/user-switch. hydrate is
      // the read-only entrypoint and always runs after the backend is
      // initialized, so pb() is safe. Idempotent; runs even when there's no
      // user yet so the hook is armed before a later sign-in.
      //
      // This is the EARLY-ARM for empty-cache sessions (nothing persists, so
      // onServerChange never fires). The LOAD-BEARING structural guarantee — the
      // hook is armed before any snapshot reaches IDB — lives in onServerChange
      // itself, which arms it as its first statement and does NOT depend on this
      // call or on BackendProvider's render order. See onServerChange.
      hookAuthChange();
      const user = pb().authStore?.record?.id;
      if (!user) return; // unauthenticated — nothing scoped to load.
      // Age-evict before reading so a stale cache doesn't paint ancient data.
      await pruneSnapshotsOlderThan(Date.now() - SNAPSHOT_TTL_MS);
      const rows = await loadSnapshotsForUser(user);
      if (rows.length === 0) return;
      hydrating = true;
      try {
        for (const r of rows) {
          // Hydration is the OLDEST possible observation (HYDRATED_SEQ): any
          // real fetch/SSE/ack overwrites it, and applyServer at HYDRATED_SEQ
          // does NOT fire onServerChange (avoids a load→persist loop).
          // composeView layers any already-replayed pending mutation on top, so
          // an in-flight optimistic write isn't clobbered by the seed.
          queue.applyServer(r.collection, r.id, r.record, HYDRATED_SEQ);
        }
      } finally {
        hydrating = false;
      }
      // Re-emit any slices that already became ready before hydrate landed
      // (best-effort for the ungated race; BackendProvider awaits hydrate so
      // the common path has no slice yet). Notifying the mirror's mutation
      // listener re-materializes affected slices with the freshly-seeded data.
      for (const r of rows) {
        notifyMutationListeners(r.collection, r.id);
      }
    },
    async replayPending() {
      const persisted = await loadAllMutations();
      for (const m of persisted) {
        // Push back into in-memory queue (preserves ordering by createdAt).
        queue.pushPending(m.collection, m.recordId, m.mutation, m.id);
        recordEvent({ kind: "replay", collection: m.collection, recordId: m.recordId, detail: { mutationId: m.id, op: m.mutation.kind } });
        // Notify the mirror's mutation listener so the optimistic state
        // from a prior session shows up immediately. Without this, the
        // mirror's view stays empty (or stale) until the replay's
        // dispatch ack arrives or some other event triggers an emit. The
        // shopping dogfood bug hit exactly this seam: the user saw a
        // ghost row whose only basis was a replayed pending mutation
        // that hadn't yet acked.
        notifyMutationListeners(m.collection, m.recordId);
        // Re-fire via the shared mutation-builder. Replay swallows
        // idempotent errors (404 on already-deleted, 409 on already-
        // created); transient errors stay queued via dispatchMutation's
        // normal path and get retried on next PB_CONNECT/focus.
        const kind: "create" | "update" | "delete" =
          m.mutation.kind === "set" ? "create" : m.mutation.kind === "update" ? "update" : "delete";
        hookRealtimeLifecycle();
        void dispatchMutation(
          m.collection,
          m.recordId,
          m.id,
          fireMutation(m.collection, m.recordId, m.mutation),
          kind,
        ).catch((err) => {
          // Replay swallows idempotent errors (404 / 409) — those mean PB
          // already converged with our intent.
          const inner = err instanceof WrappedPbError ? err.originalError : err;
          if (isIdempotentReplayError(inner)) return;
          console.warn("[wpb] replay failed for", m.collection, m.recordId, err);
        });
      }
    },
    debug: {
      events: () => debugRing.slice(),
      snapshot: () => {
        const pending = queue.allPending();
        const oldestPendingAt = pending.length > 0 ? pending[0].createdAt : null;
        const erroredEntries = Array.from(errored.values());
        const oldestErroredAt = erroredEntries.length > 0
          ? erroredEntries.reduce((min, e) => Math.min(min, e.errorAt), Infinity)
          : null;
        const erroredIdsByCollection = new Map<string, number[]>();
        for (const e of erroredEntries) {
          const arr = erroredIdsByCollection.get(e.collection) ?? [];
          arr.push(e.errorAt);
          erroredIdsByCollection.set(e.collection, arr);
        }
        const perCol: Record<string, WpbCollectionSnapshot> = {};
        // Per-collection rollup. Walk every collection with pending or
        // errored entries so the snapshot covers the full picture.
        const known = new Set<string>();
        for (const p of pending) known.add(p.collection);
        for (const e of erroredEntries) known.add(e.collection);
        for (const col of known) {
          const colPending = pending.filter((p) => p.collection === col);
          const colErroredAts = erroredIdsByCollection.get(col) ?? [];
          perCol[col] = {
            pendingMutations: colPending.length,
            erroredMutations: colErroredAts.length,
            oldestPendingAt: colPending.length > 0 ? colPending[0].createdAt : null,
            oldestErroredAt: colErroredAts.length > 0 ? Math.min(...colErroredAts) : null,
          };
        }
        return {
          totalPending: pending.length,
          totalErrored: erroredEntries.length,
          oldestPendingAt,
          oldestErroredAt: oldestErroredAt === Infinity || oldestErroredAt === null ? null : oldestErroredAt,
          collections: perCol,
        };
      },
      clear: () => { debugRing.length = 0; },
      recordEvent,
    },
    mirrorIntegration: {
      queue,
      subscribeMutations: (cb) => {
        mutationListeners.add(cb);
        return () => { mutationListeners.delete(cb); };
      },
    },
  };
}

/**
 * On replay, idempotent retries can land in either:
 *  - 409 — record already exists with this id (create that previously succeeded)
 *  - 404 — record already deleted (delete that previously succeeded)
 * Both indicate the server already reflects our intent; treat as success.
 *
 * Note: 400 is intentionally NOT swallowed because PB returns 400 for many
 * unrelated validation errors (missing fields, invalid format) that we
 * should surface, not hide.
 */
function isIdempotentReplayError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; isAbort?: boolean };
  if (e.isAbort) return false;
  return e.status === 404 || e.status === 409;
}

/**
 * Classify whether a failed write deserves to stay queued for later retry
 * (the network/server might recover) or should be dropped + surfaced to the
 * user immediately (the request is wrong and will never succeed).
 *
 * Transient (keep in queue, retry on PB_CONNECT/focus):
 *  - No status — fetch threw (offline, CORS, DNS, TLS handshake fail)
 *  - 5xx — server is sick, will likely recover
 *  - 408 — Request Timeout
 *  - 425 — Too Early
 *  - 429 — Rate Limited
 *  - 401 — token may have expired; AuthProvider's refresh will likely fix it
 *
 * Permanent (drain queue + throw):
 *  - 400 / 422 — bad request / validation
 *  - 403 — forbidden
 *  - 404 — wrong target (for fresh writes; replay handles 404 separately)
 *  - 409 — conflict (duplicate id for fresh writes; replay swallows this)
 *  - 413 — payload too large
 *
 * Aborted requests are not classified as transient — they were intentionally
 * cancelled (typically by autoCancel) and replaying them is wrong.
 */
function isTransientWriteError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; isAbort?: boolean };
  if (e.isAbort) return false;
  if (e.status === undefined || e.status === 0) return true;
  if (e.status >= 500 && e.status < 600) return true;
  if (e.status === 408 || e.status === 425 || e.status === 429) return true;
  if (e.status === 401) return true;
  return false;
}
