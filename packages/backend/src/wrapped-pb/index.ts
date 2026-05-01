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

export interface WrappedSubscribeOptions {
  /** PB-side filter string (sent to server). */
  filter?: string;
  /** JS predicate evaluated locally — required for filtered subscriptions so optimistic mutations route to the right subscribers. */
  local?: (r: RawRecord) => boolean;
}

interface LocalSubscriber {
  topic: string; // "*" or a record id
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
}

// ---- Implementation ----

interface CollectionState {
  subscribers: Set<LocalSubscriber>;
  realUnsub: Promise<UnsubscribeFunc> | null;
}

export function wrapPocketBase(pb: () => PocketBase): WrappedPocketBase {
  const queue = new MutationQueue();
  const collections = new Map<string, CollectionState>();
  const origin = newId(); // session id for this wrapper instance

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
    state.realUnsub = pb().collection(collection).subscribe("*", (e) => {
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
      // Drop mutation, emit current view, re-throw. Replay-specific errors
      // (idempotent dup/404) are handled by replayPending, not here.
      const drainResult = queue.drainPending(collection, recordId, mutationId);
      void unpersistMutation(mutationId);
      const view = drainResult.after;
      if (view === null) {
        notifySubscribers(collection, "delete", { id: recordId });
      } else {
        notifySubscribers(collection, "update", view);
      }
      throw err;
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
        });
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
        });
        return (ack ?? after) as T;
      },

      // Optimistic delete.
      async delete(id: string, opts?: RecordOptions): Promise<boolean> {
        const mutationId = newId();
        const mutation: Mutation = { kind: "delete" };

        queue.pushPending(name, id, mutation, mutationId);
        notifySubscribers(name, "delete", { id });
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
        });
        return true;
      },

      // Subscribe with a local predicate.
      async subscribe(
        topic: string,
        callback: (e: RecordSubscription) => void,
        opts?: WrappedSubscribeOptions,
      ): Promise<UnsubscribeFunc> {
        const sub: LocalSubscriber = { topic, predicate: opts?.local, callback };
        const state = getColState(name);
        state.subscribers.add(sub);
        await ensureRealSubscription(name);

        // Replay current pending mutations matching this subscriber.
        for (const r of queue.viewCollection(name, opts?.local)) {
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

  return {
    collection: makeCollection,
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
        void dispatchMutation(m.collection, m.recordId, m.id, fire).catch((err) => {
          if (isIdempotentReplayError(err)) return; // expected on retry
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
