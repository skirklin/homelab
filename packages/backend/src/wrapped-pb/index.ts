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
}

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
      if (activeSubs && activeSubs.length > 0) realtimeDirty = true;
      try { prev?.(activeSubs); } catch { /* hook owner errors are theirs */ }
    };

    // PB_CONNECT fires on every successful (re)connect, including the very
    // first. We only resync if a prior disconnect armed us — otherwise the
    // per-collection subscribe() auto-load already delivered initial state.
    void client.realtime.subscribe("PB_CONNECT", () => {
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

  async function dispatchMutation(
    collection: string,
    recordId: string,
    mutationId: string,
    fire: () => Promise<RawRecord | null>,
    kind: "create" | "update" | "delete",
  ): Promise<RawRecord | null> {
    try {
      const result = await fire();
      // Apply server snapshot from the ack response, then drain pending.
      queue.applyServer(collection, recordId, result);
      const drainResult = queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      // Emit the post-drain view so subscribers see the server-confirmed value.
      const view = drainResult.after;
      if (result === null && view === null) {
        notifySubscribers(collection, "delete", { id: recordId });
      } else if (view) {
        notifySubscribers(collection, "update", view);
      }
      return result;
    } catch (err) {
      // Drop mutation, emit current view, re-throw wrapped with op context so
      // un-awaited rejections can be toasted by a global handler. Replay-specific
      // errors (idempotent dup/404) are handled by replayPending, not here.
      const drainResult = queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      const view = drainResult.after;
      if (view === null) {
        // Use the pre-drain view so subscriber predicates (e.g. r.list === X)
        // can match. Falls back to the id-only synthesizable record if neither
        // server snapshot nor any pending mutation existed before the drain.
        notifySubscribers(collection, "delete", drainResult.before ?? { id: recordId });
      } else {
        notifySubscribers(collection, "update", view);
      }
      throw new WrappedPbError({ kind, collection, recordId }, err);
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
        notifySubscribers(name, "create", record);
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
        if (after) notifySubscribers(name, "update", after);
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
        notifySubscribers(name, "delete", before ?? { id });
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
    for (const [colName, state] of collections) {
      // SSE-liveness short-circuit: a recent event means the channel is up
      // and we trust it. The 90 s window comfortably covers any focus blip
      // while staying well under PB's 5-min idle disconnect.
      const last = lastSseEventAt.get(colName);
      if (last !== undefined && now - last < SSE_FRESH_MS) continue;
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
          queue.applyServer(g.collection, r.id, null);
          notifySubscribers(g.collection, "delete", r);
        }
      }
    }));
  }

  return {
    collection: makeCollection,
    resync,
    async replayPending() {
      const persisted = await loadAllMutations();
      for (const m of persisted) {
        // Push back into in-memory queue (preserves ordering by createdAt).
        queue.pushPending(m.collection, m.recordId, m.mutation, m.id);
        // Re-fire. Replay swallows idempotent errors (404 on already-deleted,
        // 409 on already-created); real failures propagate via console.warn
        // since there's no awaiting caller.
        const fire = async (): Promise<RawRecord | null> => {
          if (m.mutation.kind === "set") {
            const { id: _id, ...body } = m.mutation.record;
            const r = await pb().collection(m.collection).create({ ...body, id: m.recordId });
            return r as RawRecord;
          } else if (m.mutation.kind === "update") {
            const r = await pb().collection(m.collection).update(m.recordId, m.mutation.patch);
            return r as RawRecord;
          } else {
            await pb().collection(m.collection).delete(m.recordId);
            return null;
          }
        };
        const kind: "create" | "update" | "delete" =
          m.mutation.kind === "set" ? "create" : m.mutation.kind === "update" ? "update" : "delete";
        void dispatchMutation(m.collection, m.recordId, m.id, fire, kind).catch((err) => {
          // Replay swallows idempotent errors (404 / 409) — those mean PB
          // already converged with our intent.
          const inner = err instanceof WrappedPbError ? err.originalError : err;
          if (isIdempotentReplayError(inner)) return;
          console.warn("[wpb] replay failed for", m.collection, m.recordId, err);
        });
      }
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
