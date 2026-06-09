/**
 * Mutation queue + view composition.
 *
 * Per-record state: `{ server: snapshot | null, serverSeq, pending: [] }`.
 * The view of a record is `apply(pending, server)` where `apply` folds the
 * pending mutations over the server snapshot. Server events update `server`;
 * UI writes push onto `pending`. Both feed the same composition.
 *
 * Idempotent by construction: applying the same snapshot twice is a no-op,
 * and dropping a pending mutation that was already drained is a no-op.
 *
 * ── THE SEQ MODEL (monotonic server-observation versioning) ──────────────
 *
 * Every server-originated FACT carries a logical version, `seq`, drawn from a
 * single per-client monotonic counter (`nextSeq()`). The one rule that makes
 * convergence STRUCTURAL rather than emergent:
 *
 *     For a record, the NEWEST server observation wins. A bulk fetch is OLDER
 *     than any SSE event issued after it.
 *
 * `applyServer(collection, id, snapshot | null, seq)` enforces this LOCALLY and
 * TOTALLY: it REJECTS any observation whose `seq` is older than the record's
 * current `serverSeq`. There is no global "every site must agree" invariant —
 * each site just stamps its observation with a seq taken at the semantically
 * correct moment, and monotonicity does the rest:
 *
 *   - Fetch (bootstrap / resync / refetch): ONE seq taken when the fetch is
 *     ISSUED (before the await), stamped on every row on resolve. A fetch's
 *     data reflects server state ~as of issue, so a fetch issued before an SSE
 *     event must lose to it even if it resolves later.
 *   - SSE event: seq taken at ARRIVAL, per event.
 *   - Write-ack: seq taken at ack time.
 *   - Hydration from IDB: `HYDRATED_SEQ` (0), the oldest possible observation —
 *     below every real seq (which start at 1). Any real fetch/SSE/ack
 *     overwrites it. ("hydrated" provenance == `serverSeq === 0`.)
 *
 * TOMBSTONES ARE RETAINED with their seq (a null snapshot does NOT drop the
 * entry). A tombstone must out-rank a stale fetch row to prevent the
 * delete-resurrect class: a bulk fetch issued before a delete carries the row;
 * its lower seq loses to the tombstone's higher seq. Retained tombstones are
 * bounded by GC (see `noteFetchIssued` / `noteFetchResolved`).
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

/** Sentinel seq for a snapshot loaded from the IDB cache (hydration). The
 *  oldest possible observation — strictly below every real seq, so any fetch /
 *  SSE / write-ack overwrites it. `serverSeq === HYDRATED_SEQ` IS the old
 *  `hydrated` provenance bit. */
export const HYDRATED_SEQ = 0;

interface RecordState {
  server: RawRecord | null;
  /**
   * Logical version of the current `server` observation. 0 == HYDRATED_SEQ
   * (from the IDB cache) or never-observed; ≥1 == a real fetch/SSE/ack. A
   * RETAINED TOMBSTONE has `server === null` with `serverSeq > 0` — it records
   * "this record was observed ABSENT as of seq N" and out-ranks any fetch row
   * stamped with a lower seq. applyServer rejects observations older than this.
   */
  serverSeq: number;
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
 *
 * NOTE: a RETAINED TOMBSTONE is `server === null`, indistinguishable here from
 * "never observed". That's correct: a tombstone with no pending composes to
 * null (record absent); a `set` over it (an optimistic recreate) surfaces the
 * set body, exactly as for a never-seen record.
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

/** Options for MutationQueue construction. */
export interface MutationQueueOptions {
  /**
   * Fired whenever a server snapshot changes via `applyServer` — bootstrap
   * seeds, SSE events, resync, AND write-acks all funnel through that one
   * method, so this is the single chokepoint the snapshot-cache writer hooks
   * to mirror server state into IDB. `snapshot` is null for a tombstone.
   *
   * NOT fired by a HYDRATED_SEQ applyServer (hydration replay), so loading the
   * cache back in doesn't loop straight back out to IDB. NOT fired on a
   * stale-rejected observation (no state changed).
   */
  onServerChange?: (collection: string, recordId: string, snapshot: RawRecord | null) => void;
}

/** Result shape returned by every state-mutating method. `changed` is false
 *  when a monotonic applyServer rejected a stale observation (no-op). */
export interface ApplyResult {
  before: RawRecord | null;
  after: RawRecord | null;
  changed: boolean;
}

/** Single-collection store: per-record state + collection-wide listeners. */
export class MutationQueue {
  private state = new Map<string, Map<string, RecordState>>();
  private opts?: MutationQueueOptions;

  /** Monotonic observation counter. 0 is reserved for HYDRATED_SEQ; the first
   *  real observation gets 1. Orders observations WITHIN one client session —
   *  that's all that's needed (a fetch issued before an SSE event after it must
   *  carry a lower seq). */
  private seq = HYDRATED_SEQ;

  /** Seqs of fetches currently IN FLIGHT (issued, not yet resolved). A
   *  retained tombstone at seq S only needs to survive long enough to reject a
   *  fetch issued BEFORE it (seq < S). Once no in-flight fetch predates S, the
   *  tombstone can be GC'd: a fetch issued after S gets seq > S and re-observes
   *  the record correctly. Keyed by an opaque token so concurrent fetches with
   *  the same issue-seq (none today) and resolve-order don't collide. */
  private inFlightFetchSeqs = new Map<number, number>(); // token -> seq
  private fetchToken = 0;

  constructor(opts?: MutationQueueOptions) {
    this.opts = opts;
  }

  // ---- Seq source ----

  /** Take the next monotonic observation seq. */
  nextSeq(): number {
    return ++this.seq;
  }

  /** Register a fetch as in-flight at the given issue-seq. Returns a token to
   *  pass to `noteFetchResolved`. Used to bound tombstone retention. */
  noteFetchIssued(seq: number): number {
    const token = ++this.fetchToken;
    this.inFlightFetchSeqs.set(token, seq);
    return token;
  }

  /** Mark a fetch resolved/errored and GC any tombstone no in-flight fetch can
   *  still need. Call on EVERY fetch settle (resolve or error). */
  noteFetchResolved(token: number): void {
    this.inFlightFetchSeqs.delete(token);
    this.gcTombstones();
  }

  /** Smallest in-flight fetch issue-seq, or +Infinity when none are in flight
   *  (⇒ every retained tombstone is droppable). */
  private minInFlightFetchSeq(): number {
    let min = Infinity;
    for (const s of this.inFlightFetchSeqs.values()) if (s < min) min = s;
    return min;
  }

  /**
   * Drop retained tombstones that no in-flight fetch can still need. A
   * tombstone at seq S is only kept to reject a fetch issued BEFORE it
   * (seq < S). Once `min(inFlightFetchSeqs) > S` (empty set ⇒ +∞ ⇒ always),
   * no surviving fetch predates the tombstone, so it's safe to drop — a later
   * fetch gets a higher seq and re-observes the absence correctly.
   *
   * NEVER GC a tombstone with pending (composeView still needs the slot for
   * the optimistic overlay; drainPending drops it when the last pending goes).
   * NEVER GC while an older-or-equal fetch is in flight.
   */
  private gcTombstones(): void {
    const minFetch = this.minInFlightFetchSeq();
    for (const col of this.state.values()) {
      for (const [id, rec] of col) {
        if (rec.server !== null) continue;        // not a tombstone
        if (rec.pending.length > 0) continue;     // overlay still needs the slot
        if (rec.serverSeq >= minFetch) continue;  // an in-flight fetch could still need it
        col.delete(id);
      }
    }
  }

  // ---- Record state ----

  private getOrCreate(collection: string, recordId: string): RecordState {
    let col = this.state.get(collection);
    if (!col) {
      col = new Map();
      this.state.set(collection, col);
    }
    let rec = col.get(recordId);
    if (!rec) {
      rec = { server: null, serverSeq: HYDRATED_SEQ, pending: [] };
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

  /** True when a non-null server snapshot is held (regardless of pending). A
   *  RETAINED TOMBSTONE (server === null) is NOT a snapshot — it's a record of
   *  absence. Used by the mirror's bootstrap to distinguish "queue has live
   *  truth for this record" from "queue has nothing / a tombstone". */
  hasServerSnapshot(collection: string, recordId: string): boolean {
    const col = this.state.get(collection);
    if (!col) return false;
    const rec = col.get(recordId);
    return !!rec && rec.server !== null;
  }

  /** Current server observation seq for a record (HYDRATED_SEQ / 0 when
   *  never observed or hydrated-only). Lets the mirror express reconcile-by-seq
   *  ("tombstone an absent record only if the fetch is newer than what we
   *  know"). A retained tombstone reports its tombstone seq. */
  serverSeqOf(collection: string, recordId: string): number {
    const col = this.state.get(collection);
    if (!col) return HYDRATED_SEQ;
    const rec = col.get(recordId);
    return rec ? rec.serverSeq : HYDRATED_SEQ;
  }

  /** Returns the current view of a record (server snapshot + pending). */
  view(collection: string, recordId: string): RawRecord | null {
    const col = this.state.get(collection);
    if (!col) return null;
    const rec = col.get(recordId);
    if (!rec) return null;
    return composeView(rec.server, rec.pending);
  }

  /** Returns all visible records in a collection (filtered by predicate). A
   *  retained tombstone composes to null and is naturally excluded. */
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

  /**
   * Monotonic server-snapshot upsert (null = tombstone). The SINGLE ingestion
   * point for every server-originated fact: bootstrap rows, SSE events,
   * write-acks, resync rows, and IDB hydration all funnel through here.
   *
   *   - if `seq < rec.serverSeq` → NO-OP (reject stale). Returns the unchanged
   *     view with `changed: false` and does NOT fire onServerChange.
   *   - else set `rec.server = snapshot`, `rec.serverSeq = seq`. A null
   *     snapshot is a RETAINED tombstone (the entry stays, with its seq) so it
   *     out-ranks any older fetch row — the structural delete-resurrect fix.
   *     The entry is dropped only by GC (see gcTombstones) or drainPending.
   *
   * `seq` defaults to a fresh `nextSeq()` for callers that don't need
   * issue-time stamping (e.g. a write-ack), but fetch/SSE callers pass an
   * explicit seq taken at the semantically-correct moment.
   */
  applyServer(
    collection: string,
    recordId: string,
    snapshot: RawRecord | null,
    seq: number = this.nextSeq(),
  ): ApplyResult {
    const rec = this.getOrCreate(collection, recordId);
    // Monotonic reject: a stale observation never overwrites newer truth.
    // (`<` not `<=`: a re-observation at the SAME seq is idempotent and may
    // proceed, but real callers always advance the seq, so this is moot.)
    // Reaching here implies `rec.serverSeq > seq >= 0`, so the record already
    // carries a real observation (a snapshot or a retained tombstone) —
    // getOrCreate never makes a stranded empty slot on this path. Just no-op.
    if (seq < rec.serverSeq) {
      const v = composeView(rec.server, rec.pending);
      return { before: v, after: v, changed: false };
    }
    const before = composeView(rec.server, rec.pending);
    rec.server = snapshot;
    rec.serverSeq = seq;
    // Tombstones are RETAINED (do not delete the entry on snapshot===null) so
    // they out-rank a stale fetch row. GC reclaims them once safe.
    const after = composeView(rec.server, rec.pending);
    // Mirror the server-state change to any cache writer — EXCEPT hydration
    // (HYDRATED_SEQ), which was just read FROM the cache (re-emitting it would
    // be a pointless load→persist loop).
    if (seq !== HYDRATED_SEQ) this.opts?.onServerChange?.(collection, recordId, snapshot);
    return { before, after, changed: true };
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
    // Drop the entry only when it carries no server fact AND no pending. A
    // RETAINED TOMBSTONE (serverSeq > 0) is kept — GC reclaims it when safe so
    // it can still out-rank an in-flight stale fetch. A never-observed slot
    // (serverSeq 0, server null) left empty by the last drain is dropped.
    if (rec.server === null && rec.pending.length === 0 && rec.serverSeq === HYDRATED_SEQ) {
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
