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

/** Compose pending mutations on top of the server snapshot. Pure. */
export function composeView(
  server: RawRecord | null,
  pending: PendingMutation[],
): RawRecord | null {
  let result: RawRecord | null = server;
  for (const p of pending) {
    switch (p.mutation.kind) {
      case "set":
        result = p.mutation.record;
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
