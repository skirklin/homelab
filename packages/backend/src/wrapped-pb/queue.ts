/**
 * Mutation queue + view composition.
 *
 * Per-record state: `{ server: snapshot | null, pending: PendingMutation[] }`.
 * The view of a record is `apply(pending, server)` where `apply` folds the
 * pending mutations over the server snapshot. Server events update `server`;
 * UI writes push onto `pending`. Both feed the same composition.
 *
 * Idempotent by construction: applying the same snapshot twice is a no-op,
 * and dropping a pending mutation that was already drained is a no-op.
 */

export type RawRecord = Record<string, unknown> & { id: string };

export type Mutation =
  | { kind: "set"; record: RawRecord }
  | { kind: "update"; patch: Record<string, unknown> }
  | { kind: "delete" };

export interface PendingMutation {
  /** Unique id for this mutation entry — used to drain on ack/reject. */
  id: string;
  collection: string;
  recordId: string;
  mutation: Mutation;
  createdAt: number;
}

interface RecordState {
  server: RawRecord | null;
  pending: PendingMutation[];
}

/**
 * Compose pending mutations on top of the server snapshot. Pure.
 *
 * Semantics of `set`:
 *   - When there's no server snapshot, the set body IS the optimistic view.
 *     This is what powers optimistic creates with client-supplied IDs:
 *     wpb.create pushes a set, composeView surfaces it to consumers
 *     before the POST acks.
 *   - When a server snapshot already exists, the set is treated as a
 *     no-op. Rationale: every `set` originates from `wpb.create()`, which
 *     means "create a record with this id and body". If the server already
 *     has a snapshot for this id, the create has either succeeded
 *     server-side (the set is moot; pending will drain on ack) or the
 *     record pre-existed (the set will 409 and drain via permanent-error
 *     path). In neither case should the set's stale create-time body
 *     replace fresher server truth. Concretely: a stale persisted set
 *     replayed from IDB used to override a freshly-fetched server
 *     snapshot, making a checked item appear unchecked (the dogfood
 *     oscillation bug; realworld.test.ts:A11).
 *   - Updates after a no-op'd set still apply to the server snapshot as
 *     normal, so the optimistic write chain converges.
 */
export function composeView(
  server: RawRecord | null,
  pending: PendingMutation[],
): RawRecord | null {
  let result: RawRecord | null = server;
  for (const p of pending) {
    switch (p.mutation.kind) {
      case "set":
        // No-op when server truth exists (see fn comment). Otherwise the
        // set body becomes the optimistic view.
        if (result === null) result = p.mutation.record;
        break;
      case "update":
        result = result ? { ...result, ...p.mutation.patch } : null;
        break;
      case "delete":
        result = null;
        break;
    }
  }
  return result;
}

/** Single-collection store: per-record state + collection-wide listeners. */
export class MutationQueue {
  private state = new Map<string, Map<string, RecordState>>();

  // ---- Record state ----

  private getOrCreate(collection: string, recordId: string): RecordState {
    let col = this.state.get(collection);
    if (!col) {
      col = new Map();
      this.state.set(collection, col);
    }
    let rec = col.get(recordId);
    if (!rec) {
      rec = { server: null, pending: [] };
      col.set(recordId, rec);
    }
    return rec;
  }

  /** True when the record has at least one pending (unacked) mutation. */
  hasPending(collection: string, recordId: string): boolean {
    const col = this.state.get(collection);
    if (!col) return false;
    const rec = col.get(recordId);
    return !!rec && rec.pending.length > 0;
  }

  /** True when an applyServer snapshot exists (regardless of pending state).
   *  Used by the mirror's bootstrap to distinguish "queue has nothing for
   *  this record" (safe to seed from a fresh fetch) from "queue already
   *  has a server snapshot, possibly fresher than ours (e.g. an SSE event
   *  that raced ahead during our await)". A pending-only entry is NOT a
   *  server snapshot — composeView still needs server truth underneath. */
  hasServerSnapshot(collection: string, recordId: string): boolean {
    const col = this.state.get(collection);
    if (!col) return false;
    const rec = col.get(recordId);
    return !!rec && rec.server !== null;
  }

  /** Returns the current view of a record (server snapshot + pending). */
  view(collection: string, recordId: string): RawRecord | null {
    const col = this.state.get(collection);
    if (!col) return null;
    const rec = col.get(recordId);
    if (!rec) return null;
    return composeView(rec.server, rec.pending);
  }

  /** Returns all visible records in a collection (filtered by predicate). */
  viewCollection(
    collection: string,
    predicate?: (r: RawRecord) => boolean,
  ): RawRecord[] {
    const col = this.state.get(collection);
    if (!col) return [];
    const out: RawRecord[] = [];
    for (const rec of col.values()) {
      const v = composeView(rec.server, rec.pending);
      if (v && (!predicate || predicate(v))) out.push(v);
    }
    return out;
  }

  /**
   * Like viewCollection but only returns records with pending mutations.
   * Used by subscribe replay so server-only seeded records (which the
   * caller already loaded via its own initial fetch) aren't double-emitted.
   */
  viewPending(
    collection: string,
    predicate?: (r: RawRecord) => boolean,
  ): RawRecord[] {
    const col = this.state.get(collection);
    if (!col) return [];
    const out: RawRecord[] = [];
    for (const rec of col.values()) {
      if (rec.pending.length === 0) continue;
      const v = composeView(rec.server, rec.pending);
      if (v && (!predicate || predicate(v))) out.push(v);
    }
    return out;
  }

  /** Server snapshot upserted (null = tombstone). Returns the prior view. */
  applyServer(
    collection: string,
    recordId: string,
    snapshot: RawRecord | null,
  ): { before: RawRecord | null; after: RawRecord | null } {
    const rec = this.getOrCreate(collection, recordId);
    const before = composeView(rec.server, rec.pending);
    rec.server = snapshot;
    if (snapshot === null && rec.pending.length === 0) {
      this.state.get(collection)?.delete(recordId);
    }
    const after = composeView(rec.server, rec.pending);
    return { before, after };
  }

  /** Push a pending mutation. Returns the id assigned to it. */
  pushPending(
    collection: string,
    recordId: string,
    mutation: Mutation,
    mutationId: string,
  ): { before: RawRecord | null; after: RawRecord | null } {
    const rec = this.getOrCreate(collection, recordId);
    const before = composeView(rec.server, rec.pending);
    rec.pending.push({
      id: mutationId,
      collection,
      recordId,
      mutation,
      createdAt: Date.now(),
    });
    const after = composeView(rec.server, rec.pending);
    return { before, after };
  }

  /** Drain a pending mutation by id. Returns whether it was found. */
  drainPending(
    collection: string,
    recordId: string,
    mutationId: string,
  ): { found: boolean; before: RawRecord | null; after: RawRecord | null } {
    const col = this.state.get(collection);
    const rec = col?.get(recordId);
    if (!rec) return { found: false, before: null, after: null };
    const idx = rec.pending.findIndex((p) => p.id === mutationId);
    if (idx < 0) {
      const v = composeView(rec.server, rec.pending);
      return { found: false, before: v, after: v };
    }
    const before = composeView(rec.server, rec.pending);
    rec.pending.splice(idx, 1);
    if (rec.server === null && rec.pending.length === 0) {
      col!.delete(recordId);
    }
    const after = composeView(rec.server, rec.pending);
    return { found: true, before, after };
  }

  /** All pending mutations across all records — for persistence + replay. */
  allPending(): PendingMutation[] {
    const out: PendingMutation[] = [];
    for (const col of this.state.values()) {
      for (const rec of col.values()) {
        out.push(...rec.pending);
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }
}
