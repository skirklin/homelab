/**
 * Optimistic-write wrapper around PocketBase.
 *
 * Mirrors Firestore's mutation-queue + server-snapshot model. UI writes push
 * onto a per-record queue and notify subscribers synchronously; the network
 * call fires in the background. Server events from PB realtime feed the same
 * queue. Convergence falls out of last-write-wins composition.
 *
 * Persistence: pending mutations are written to IndexedDB before dispatch and
 * cleared on ack/reject. A reload mid-flight replays them on next session.
 * Replay is safe because creates use client-supplied IDs (idempotent), updates
 * are last-write-wins patches, and deletes treat 404 as success.
 */
import type PocketBase from "pocketbase";
import type { RecordModel, RecordSubscription, UnsubscribeFunc, RecordOptions, RecordListOptions, RecordFullListOptions, ListResult } from "pocketbase";
import { newId } from "../cache/ids";
import { MutationQueue, type Mutation, type RawRecord } from "./queue";
import { persistMutation, unpersistMutation, loadAllMutations } from "./persistence";

export { MutationQueue, composeView, type Mutation, type RawRecord, type PendingMutation } from "./queue";
export { type PersistedMutation, persistMutation, loadAllMutations, clearAllMutations } from "./persistence";
export { newId } from "../cache/ids";

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

export interface WrappedSubscribeOptions {
  /**
   * PocketBase filter string used to scope the initial-load fetch when
   * `topic === "*"`. Without it, "*" subscribes deliver only live events
   * (no initial state). For specific-id topics, the id alone scopes the
   * fetch and `filter` is ignored.
   */
  filter?: string;
  /** JS predicate evaluated locally — required for filtered subscriptions so optimistic mutations route to the right subscribers. */
  local?: (r: RawRecord) => boolean;
}

interface LocalSubscriber {
  collection: string;
  topic: string; // "*" or a record id
  filter?: string; // server-side filter that was passed at subscribe time
  predicate?: (r: RawRecord) => boolean;
  callback: (e: RecordSubscription) => void;
}

export interface WrappedCollection {
  // Reads — passthrough today (overlay is a v2 concern; subscribe channel
  // delivers pending mutations to live UIs).
  getFullList<T = RecordModel>(opts?: RecordFullListOptions): Promise<T[]>;
  getFullList<T = RecordModel>(batch?: number, opts?: RecordListOptions): Promise<T[]>;
  getList<T = RecordModel>(page?: number, perPage?: number, opts?: RecordListOptions): Promise<ListResult<T>>;
  getFirstListItem<T = RecordModel>(filter: string, opts?: RecordListOptions): Promise<T>;
  getOne<T = RecordModel>(id: string, opts?: RecordOptions): Promise<T>;
  /** Synchronous in-memory read (server snapshot + pending overlay). Returns null if not cached. */
  view<T = RecordModel>(id: string): T | null;
  /** Synchronous scan of all cached records (server + pending) matching predicate. */
  viewCollection<T = RecordModel>(predicate?: (r: T) => boolean): T[];
  // Optimistic writes — return Promise<server record> resolved on ack.
  create<T = RecordModel>(body: Record<string, unknown>, opts?: RecordOptions): Promise<T>;
  update<T = RecordModel>(id: string, body: Record<string, unknown>, opts?: RecordOptions): Promise<T>;
  delete(id: string, opts?: RecordOptions): Promise<boolean>;
  subscribe(
    topic: string,
    cb: (e: RecordSubscription) => void,
    opts?: WrappedSubscribeOptions,
  ): Promise<UnsubscribeFunc>;
}

export interface WrappedPocketBase {
  collection(name: string): WrappedCollection;
  /** Triggers persisted-mutation replay. Idempotent. Call once after auth is ready. */
  replayPending(): Promise<void>;
  /**
   * Re-fetch every active subscription's matching records, apply them to the
   * queue, and synthesize create/update/delete events for any drift since
   * the last delivery. Compensates for PocketBase's 5-minute realtime idle
   * disconnect (and any mobile-network SSE failure where the SDK's
   * auto-reconnect misses events) by treating server state as authoritative
   * on every wake-up. Call on tab focus/pageshow and on a slow interval.
   */
  resync(): Promise<void>;
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
}

/** Kinds of internal events recorded for post-hoc debugging. */
export type WpbEventKind =
  | "subscribe"        // a local subscriber attached
  | "unsubscribe"      // a local subscriber detached
  | "sse"              // an SSE event was delivered for a collection
  | "mutation-push"    // wpb pushed a pending mutation to the queue
  | "mutation-ack"     // server confirmed a mutation
  | "mutation-error"   // server rejected a mutation
  | "replay"           // replayPending re-fired a persisted mutation
  | "resync"           // resync() reconciled state for a collection
  | "retry-batch"      // retryErrored() began a sweep of queued failed writes
  | "disconnect"       // SDK reported realtime drop
  | "connect";         // SDK reported realtime (re)connect

export interface WpbEvent {
  t: number; // ms since epoch
  kind: WpbEventKind;
  collection?: string;
  recordId?: string;
  detail?: Record<string, unknown>;
}

export interface WpbCollectionSnapshot {
  subscribers: number;
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
  /** Last SSE-delivered event timestamp (ms epoch), null if none. */
  lastSseEventAt: number | null;
}

export interface WpbSnapshot {
  /** PB SDK's view of whether the realtime EventSource is open. */
  realtimeConnected: boolean;
  /** Set when onDisconnect fired and PB_CONNECT hasn't cleared it yet. */
  realtimeDirty: boolean;
  totalPending: number;
  totalErrored: number;
  oldestPendingAt: number | null;
  oldestErroredAt: number | null;
  collections: Record<string, WpbCollectionSnapshot>;
}

export interface WpbDebug {
  /** Read-only view of the most recent N events (newest last). */
  events(): readonly WpbEvent[];
  /** Live snapshot of subscribers, pending writes, and realtime state. */
  snapshot(): WpbSnapshot;
  /** Drop the in-memory ring buffer. Does not touch persisted mutations. */
  clear(): void;
}

/** Cap on the ring buffer — enough to cover a few minutes of activity, small
 *  enough that the memory footprint and stringify cost is irrelevant. */
const DEBUG_RING_CAPACITY = 200;

// ---- Implementation ----

interface CollectionState {
  subscribers: Set<LocalSubscriber>;
  realUnsub: Promise<UnsubscribeFunc> | null;
}

/**
 * Window inside which a recently-seen SSE event proves the realtime channel
 * is alive — resync() skips any collection that delivered an event in the
 * last `SSE_FRESH_MS` ms. PocketBase's idle disconnect kicks in at 5 min, so
 * 90 s is comfortably under the worst-case "we missed everything since the
 * last live event" window while still catching real drop-outs on the very
 * next focus tick.
 */
const SSE_FRESH_MS = 90 * 1000;

export function wrapPocketBase(pb: () => PocketBase): WrappedPocketBase {
  const queue = new MutationQueue();
  const collections = new Map<string, CollectionState>();
  const origin = newId(); // session id for this wrapper instance
  /** Per-collection timestamp of the most recent SSE-delivered event. */
  const lastSseEventAt = new Map<string, number>();
  /**
   * Hook listeners for "any mutation was pushed/drained/applied". PBMirror
   * uses this to re-emit slices when an optimistic write lands or is rolled
   * back. Kept as a tiny event-emitter rather than widening the public
   * WrappedPocketBase interface — the mirror lives in the same package and
   * grabs the hook via the `__onMutation` side-channel on the returned
   * object. Other code paths don't need this and won't see it.
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
  /**
   * Set when the PB SDK reports a realtime disconnect with active subscriptions.
   * Cleared after the next successful PB_CONNECT triggers a resync. This is
   * the desktop-drop fast path: we don't have to wait for tab focus to
   * notice the SSE died — the SDK tells us, we resync the moment SSE comes
   * back. Mobile-suspend doesn't fire onDisconnect (the OS freezes the
   * network stack silently), which is why we still keep the focus-driven
   * resync as a backstop.
   */
  let realtimeDirty = false;
  /** Idempotency guard for the disconnect hook + PB_CONNECT subscription. */
  let realtimeHooked = false;

  function hookRealtimeLifecycle() {
    if (realtimeHooked) return;
    const client = pb();
    if (!client.realtime) return;
    realtimeHooked = true;

    const prev = client.realtime.onDisconnect;
    client.realtime.onDisconnect = (activeSubs) => {
      // Only mark dirty when there were live subscriptions to lose — an
      // unsubscribe-all teardown also fires this, and we don't want to
      // resync on graceful close.
      if (activeSubs && activeSubs.length > 0) {
        realtimeDirty = true;
        recordEvent({ kind: "disconnect", detail: { activeSubs } });
      }
      try { prev?.(activeSubs); } catch { /* hook owner errors are theirs */ }
    };

    // PB_CONNECT fires on every successful (re)connect, including the very
    // first. We only resync if a prior disconnect armed us — otherwise the
    // per-collection subscribe() auto-load already delivered initial state.
    void client.realtime.subscribe("PB_CONNECT", () => {
      recordEvent({ kind: "connect", detail: { afterDirty: realtimeDirty } });
      // Always sweep errored writes on a fresh connection — they may have
      // failed precisely because the network was down, and now isn't.
      // Cheap when the errored map is empty (early return inside).
      void retryErrored();
      if (!realtimeDirty) return;
      realtimeDirty = false;
      void resync();
    });
  }

  function getColState(name: string): CollectionState {
    let s = collections.get(name);
    if (!s) {
      s = { subscribers: new Set(), realUnsub: null };
      collections.set(name, s);
    }
    return s;
  }

  function notifySubscribers(
    collection: string,
    action: "create" | "update" | "delete",
    record: RawRecord,
  ) {
    const s = collections.get(collection);
    if (!s) return;
    for (const sub of s.subscribers) {
      if (sub.topic !== "*" && sub.topic !== record.id) continue;
      if (sub.predicate && !sub.predicate(record)) continue;
      try {
        sub.callback({ action, record: record as RecordModel });
      } catch (err) {
        console.error("[wpb] subscriber callback threw", err);
      }
    }
  }

  function ensureRealSubscription(collection: string): Promise<UnsubscribeFunc> {
    const state = getColState(collection);
    if (state.realUnsub) return state.realUnsub;
    // Hook the realtime lifecycle once — first subscribe is the earliest
    // we know the app is actually using the channel. Doing it lazily here
    // avoids materializing pb() in environments that import wpb but never
    // subscribe (e.g., the test stub before its first subscribe call).
    hookRealtimeLifecycle();
    state.realUnsub = pb().collection(collection).subscribe("*", (e) => {
      // Any SSE delivery proves the realtime channel is currently alive for
      // this collection. Stamp the time so the focus-driven resync can skip
      // unnecessary refetches on healthy tabs.
      lastSseEventAt.set(collection, Date.now());
      const action = e.action as "create" | "update" | "delete";
      const record = e.record as RawRecord;
      recordEvent({ kind: "sse", collection, recordId: record?.id, detail: { action } });
      if (action === "delete") {
        const { after } = queue.applyServer(collection, record.id, null);
        notifySubscribers(collection, "delete", record);
        // If pending mutations leave a non-null view, also re-emit so listeners stay current.
        if (after) notifySubscribers(collection, "update", after);
      } else {
        const { before, after } = queue.applyServer(collection, record.id, record);
        const emitAction = before === null && after !== null ? "create" : "update";
        if (after) notifySubscribers(collection, emitAction, after);
      }
    });
    return state.realUnsub;
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
   * Build the network call for a given mutation. Centralized so both the
   * initial dispatch and the retry / replay paths reconstruct the request
   * the same way without duplicating the kind-switching logic.
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
      if (dispatchChains.get(chainKey) === chainLink) dispatchChains.delete(chainKey);
    });
    return outcome;

    async function runOne(): Promise<RawRecord | null> {
    try {
      const result = await fire();
      // Apply server snapshot from the ack response, then drain pending.
      queue.applyServer(collection, recordId, result);
      const drainResult = queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      errored.delete(mutationId);
      recordEvent({ kind: "mutation-ack", collection, recordId, detail: { mutationId, op: kind } });
      // Emit the post-drain view so subscribers see the server-confirmed value.
      const view = drainResult.after;
      if (result === null && view === null) {
        notifySubscribers(collection, "delete", { id: recordId });
      } else if (view) {
        notifySubscribers(collection, "update", view);
      }
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
        // Don't notify a revert — the optimistic queue entry is still there,
        // subscribers' views are unchanged. Don't throw — caller's await
        // resolves so the UI continues without alarming the user about a
        // network blip that will likely auto-recover.
        return null;
      }

      // Permanent error: drain, drop persisted copy, notify revert, throw.
      const drainResult = queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      errored.delete(mutationId);
      recordEvent({
        kind: "mutation-error",
        collection,
        recordId,
        detail: { mutationId, op: kind, status, message, transient: false },
      });
      const view = drainResult.after;
      if (view === null) {
        // Use the pre-drain view so subscriber predicates (e.g. r.list === X)
        // can match. Falls back to the id-only synthesizable record if neither
        // server snapshot nor any pending mutation existed before the drain.
        notifySubscribers(collection, "delete", drainResult.before ?? { id: recordId });
      } else {
        notifySubscribers(collection, "update", view);
      }
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

      // Optimistic create. Subscribers see the create event synchronously;
      // persistence is fire-and-forget (non-blocking).
      async create<T = RecordModel>(body: Record<string, unknown>, opts?: RecordOptions): Promise<T> {
        const id = (body.id as string) || newId();
        const record = synthesizeRecord(name, { ...body, id }, id);
        const mutationId = newId();
        const mutation: Mutation = { kind: "set", record };

        queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "create" } });
        notifySubscribers(name, "create", record);
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
        const mutationId = newId();
        const mutation: Mutation = { kind: "update", patch: body };

        const { after } = queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "update" } });
        if (after) notifySubscribers(name, "update", after);
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
        const mutationId = newId();
        const mutation: Mutation = { kind: "delete" };

        // Capture the prior view BEFORE adding the delete mutation so we can
        // emit it as the event record — predicates need the full record (with
        // the list/log/parent fields) to match, not just the id.
        const { before } = queue.pushPending(name, id, mutation, mutationId);
        recordEvent({ kind: "mutation-push", collection: name, recordId: id, detail: { mutationId, op: "delete" } });
        notifySubscribers(name, "delete", before ?? { id });
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

      // Subscribe with onSnapshot-style semantics: caller gets a unified
      // stream of "create" events for current matching records (initial load),
      // followed by live create/update/delete events. Returned promise
      // resolves only after the initial batch has been delivered, so callers
      // can flip a loading flag at that point.
      //
      // Initial load also seeds the optimistic queue. Without this, a local
      // delete/update on a record that has only ever been read (never had an
      // SSE event) would compose against a null server snapshot and emit a
      // bare {id} (failing subscriber predicates) or no event at all (update
      // on null is a no-op). On mobile, where SSE is unreliable, that means
      // the user's own writes never reach the UI until a refresh.
      async subscribe(
        topic: string,
        callback: (e: RecordSubscription) => void,
        opts?: WrappedSubscribeOptions,
      ): Promise<UnsubscribeFunc> {
        const sub: LocalSubscriber = {
          collection: name,
          topic,
          filter: opts?.filter,
          predicate: opts?.local,
          callback,
        };
        const state = getColState(name);
        state.subscribers.add(sub);
        recordEvent({ kind: "subscribe", collection: name, detail: { topic, filter: opts?.filter } });
        await ensureRealSubscription(name);

        // Auto-load matching records and seed the queue. Two scopes:
        //  - topic="*" with filter: getFullList(filter) → batch
        //  - topic=<id>: getOne(id) → single record (404 → empty)
        // topic="*" without filter is left alone; callers that want raw
        // event-only semantics can use that form.
        let initialRecords: RawRecord[] = [];
        if (topic !== "*") {
          try {
            const r = await pb().collection(name).getOne(topic, { $autoCancel: false });
            initialRecords = [r as unknown as RawRecord];
          } catch {
            // 404 / not found is fine — record may not exist yet; live events
            // will deliver any future create.
          }
        } else if (opts?.filter !== undefined) {
          try {
            const rs = await pb().collection(name).getFullList({
              filter: opts.filter,
              $autoCancel: false,
            });
            initialRecords = rs as unknown as RawRecord[];
          } catch (e) {
            console.warn(`[wpb] initial load for ${name} failed`, e);
          }
        }

        // Seed and deliver. Two distinct concerns here:
        //  1. Seeding: only seed if the queue doesn't already have a snapshot
        //     for this id. A prior subscriber's seed (or an SSE event that
        //     raced ahead during our await) may already hold a fresher view;
        //     re-seeding from our potentially-stale getFullList would clobber
        //     it.
        //  2. Delivery: ALWAYS deliver to THIS subscriber. Whether the queue
        //     was just-seeded or already populated, this subscriber was just
        //     attached and has not yet received any event for this record.
        //     (Pre-fix, skipping delivery when queue.view !== null caused a
        //     real bug: home shell mounts ShoppingProvider + RecipesProvider
        //     concurrently and both wpb.subscribe('users', uid); the second
        //     one's onSlugs callback never fired and lists rendered empty.)
        // Deliver from queue.view so we forward whatever's freshest, not
        // necessarily the snapshot we just fetched.
        for (const r of initialRecords) {
          if (queue.view(name, r.id) === null) {
            queue.applyServer(name, r.id, r);
          }
          const view = queue.view(name, r.id);
          if (!view) continue;
          if (topic !== "*" && topic !== view.id) continue;
          if (opts?.local && !opts.local(view)) continue;
          try {
            callback({ action: "create", record: view as RecordModel });
          } catch (err) {
            console.error("[wpb] initial replay threw", err);
          }
        }

        // Replay current pending mutations matching this subscriber.
        // Only records with pending mutations are replayed; server-only
        // snapshots (already delivered above as part of the initial batch)
        // are skipped to avoid double-emission.
        for (const r of queue.viewPending(name, opts?.local)) {
          if (topic !== "*" && topic !== r.id) continue;
          try {
            callback({ action: "create", record: r as RecordModel });
          } catch (err) {
            console.error("[wpb] subscriber replay threw", err);
          }
        }

        return async () => {
          state.subscribers.delete(sub);
          recordEvent({ kind: "unsubscribe", collection: name, detail: { topic } });
          // Tear down real subscription when the last local subscriber leaves.
          if (state.subscribers.size === 0 && state.realUnsub) {
            const unsub = await state.realUnsub;
            state.realUnsub = null;
            try { await unsub(); } catch { /* ignore */ }
          }
        };
      },
    };
  }

  /**
   * Re-fetch every active subscription's matching records and reconcile against
   * the local queue. Emits create/update for new or changed records and delete
   * for records that previously matched a filter but no longer exist or no
   * longer match.
   *
   * Skips collections whose SSE channel has delivered an event within the
   * last SSE_FRESH_MS — those are demonstrably alive and a refetch would
   * be pure overhead. Skips no-op records (queue view already matches the
   * server) so even an active focus-resync of a chatty tab is silent on
   * the wire that matters (no notifySubscribers churn).
   */
  async function resync(): Promise<void> {
    const now = Date.now();
    // Group subscriptions by (collection, topic, filter) to avoid duplicate
    // network calls when multiple components subscribe with the same shape.
    const groups = new Map<string, { collection: string; topic: string; filter?: string; predicate?: (r: RawRecord) => boolean }>();
    const skippedFresh: string[] = [];
    for (const [colName, state] of collections) {
      // SSE-liveness short-circuit: a recent event means the channel is up
      // and we trust it. The 90 s window comfortably covers any focus blip
      // while staying well under PB's 5-min idle disconnect.
      const last = lastSseEventAt.get(colName);
      if (last !== undefined && now - last < SSE_FRESH_MS) { skippedFresh.push(colName); continue; }
      for (const sub of state.subscribers) {
        const key = `${colName}|${sub.topic}|${sub.filter ?? ""}`;
        if (groups.has(key)) continue;
        groups.set(key, {
          collection: colName,
          topic: sub.topic,
          filter: sub.filter,
          predicate: sub.predicate,
        });
      }
    }

    await Promise.all(Array.from(groups.values()).map(async (g) => {
      // Refetch via the same path subscribe() uses for initial load.
      let records: RawRecord[] = [];
      try {
        if (g.topic !== "*") {
          const r = await pb().collection(g.collection).getOne(g.topic, { $autoCancel: false });
          records = [r as unknown as RawRecord];
        } else if (g.filter !== undefined) {
          const rs = await pb().collection(g.collection).getFullList({
            filter: g.filter,
            $autoCancel: false,
          });
          records = rs as unknown as RawRecord[];
        } else {
          // Unfiltered "*" subscribe — no canonical refetch target. Skip;
          // the subscriber asked for raw events without a filter, so there's
          // no defined set of records to reconcile against.
          return;
        }
      } catch (err) {
        // 404 on a single-record subscribe is a legitimate "record gone" signal.
        if (g.topic !== "*" && (err as { status?: number })?.status === 404) {
          const before = queue.view(g.collection, g.topic);
          if (before) {
            queue.applyServer(g.collection, g.topic, null);
            notifySubscribers(g.collection, "delete", before);
          }
          return;
        }
        // Network / auth blip — leave local state alone and try again next probe.
        return;
      }

      // Apply each fetched record. applyServer returns before/after; emit a
      // notify only when the view actually changed. Skipping no-op records
      // keeps the focus probe from flooding subscribers with unchanged data.
      const seen = new Set<string>();
      for (const r of records) {
        seen.add(r.id);
        const { before, after } = queue.applyServer(g.collection, r.id, r);
        if (!after) continue;
        if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
        const action = before === null ? "create" : "update";
        notifySubscribers(g.collection, action, after);
      }

      // For filtered subscriptions, anything previously in the queue that
      // matched this subscriber's predicate but is missing from the refetch
      // was deleted server-side during the disconnect window. Emit deletes
      // so consumers' maps drop the stale entries.
      if (g.topic === "*" && g.predicate) {
        const stale = queue.viewCollection(g.collection, g.predicate);
        for (const r of stale) {
          if (seen.has(r.id)) continue;
          // Skip records with in-flight optimistic mutations. Their absence
          // from `records` doesn't mean the server deleted them — the server
          // just hasn't observed our create/update yet. Synthesizing a delete
          // here would tear down the user's own optimistic row mid-write.
          // The pending mutation's eventual ack (or reject) will reconcile
          // server state for real.
          if (queue.hasPending(g.collection, r.id)) continue;
          queue.applyServer(g.collection, r.id, null);
          notifySubscribers(g.collection, "delete", r);
        }
      }
    }));

    recordEvent({
      kind: "resync",
      detail: {
        groupsRefetched: Array.from(groups.values()).map((g) => g.collection),
        skippedFresh,
        durationMs: Date.now() - now,
      },
    });
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
    resync,
    retryErrored,
    async replayPending() {
      const persisted = await loadAllMutations();
      for (const m of persisted) {
        // Push back into in-memory queue (preserves ordering by createdAt).
        queue.pushPending(m.collection, m.recordId, m.mutation, m.id);
        recordEvent({ kind: "replay", collection: m.collection, recordId: m.recordId, detail: { mutationId: m.id, op: m.mutation.kind } });
        // Notify subscribers (legacy wpb.subscribe path) and the mirror's
        // mutation listener so the optimistic state from a prior session
        // shows up immediately. Without this, the mirror's view stays
        // empty (or stale) until the replay's dispatch ack arrives or
        // some other event triggers an emit. The shopping dogfood bug
        // hit exactly this seam: the user saw a ghost row whose only
        // basis was a replayed pending mutation that hadn't yet acked.
        const view = queue.view(m.collection, m.recordId);
        if (view) {
          notifySubscribers(m.collection, m.mutation.kind === "delete" ? "delete" : "update", view);
        } else if (m.mutation.kind === "delete") {
          notifySubscribers(m.collection, "delete", { id: m.recordId });
        }
        notifyMutationListeners(m.collection, m.recordId);
        // Re-fire via the shared mutation-builder. Replay swallows
        // idempotent errors (404 on already-deleted, 409 on already-
        // created); transient errors stay queued via dispatchMutation's
        // normal path and get retried on next PB_CONNECT/focus.
        const kind: "create" | "update" | "delete" =
          m.mutation.kind === "set" ? "create" : m.mutation.kind === "update" ? "update" : "delete";
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
        // Per-collection rollup. Walk every collection we know about (either
        // has subscribers, pending mutations, or errored entries) so the
        // snapshot covers the full picture.
        const known = new Set<string>(collections.keys());
        for (const p of pending) known.add(p.collection);
        for (const e of erroredEntries) known.add(e.collection);
        for (const col of known) {
          const state = collections.get(col);
          const colPending = pending.filter((p) => p.collection === col);
          const colErroredAts = erroredIdsByCollection.get(col) ?? [];
          perCol[col] = {
            subscribers: state?.subscribers.size ?? 0,
            pendingMutations: colPending.length,
            erroredMutations: colErroredAts.length,
            oldestPendingAt: colPending.length > 0 ? colPending[0].createdAt : null,
            oldestErroredAt: colErroredAts.length > 0 ? Math.min(...colErroredAts) : null,
            lastSseEventAt: lastSseEventAt.get(col) ?? null,
          };
        }
        let realtimeConnected = false;
        try { realtimeConnected = !!pb().realtime?.isConnected; } catch { /* pb not ready */ }
        return {
          realtimeConnected,
          realtimeDirty,
          totalPending: pending.length,
          totalErrored: erroredEntries.length,
          oldestPendingAt,
          oldestErroredAt: oldestErroredAt === Infinity || oldestErroredAt === null ? null : oldestErroredAt,
          collections: perCol,
        };
      },
      clear: () => { debugRing.length = 0; },
    },
    // Side-channels for PBMirror (same package). Not part of the public
    // WrappedPocketBase contract — cast to access. See mirror.ts for why.
    __queue: queue,
    __onMutation: (cb: (collection: string, recordId: string) => void) => {
      mutationListeners.add(cb);
      return () => { mutationListeners.delete(cb); };
    },
  } as WrappedPocketBase & {
    __queue: MutationQueue;
    __onMutation: (cb: (collection: string, recordId: string) => void) => () => void;
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
