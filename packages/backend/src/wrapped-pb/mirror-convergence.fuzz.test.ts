/**
 * PBMirror convergence fuzzer (property-based).
 *
 * GOAL — make the mirror's reconciliation correctness STRUCTURAL. This fuzzer
 * generates randomized interleavings of (initial bootstrap fetch, SSE
 * create/update/delete, optimistic client mutation, disconnect→reconnect→resync)
 * and asserts that the mirror's last-emitted materialized view CONVERGES to an
 * independently-computed oracle view derived purely from the final server state.
 *
 * It is the mechanical net for the silent-corruption interleaving bugs that, to
 * date, only adversarial human review has caught (Blocker-1/2, the pre-
 * registration-event race, the sort+limit window-boundary class).
 *
 * ── DESIGN PRINCIPLES (see the task brief) ────────────────────────────────
 *
 * BLACK-BOX. The fuzzer drives ONLY the public surface:
 *   - mirror.watch(spec, onState)
 *   - the stub `pb` server (server-side create/update/delete + SSE delivery)
 *   - wpb optimistic writes (wpb.collection(c).create/update/delete)
 *   - mirror.resync({ force: true })
 * It asserts ONLY on emitted views. It NEVER reads mirror internals
 * (slice.records, consolidated, sseTouchedDuringBootstrap, ready, …). Steps 2/3
 * of the hardening plan will delete those flags; this fuzzer must survive that
 * refactor and GUARD it.
 *
 * INDEPENDENT ORACLE. `ServerModel` below is a dead-simple Map<id, record |
 * TOMBSTONE> mutated by each server op. The expected converged view for a slice
 * is a PURE function of the FINAL server state — a few lines of obvious code
 * (filter → sort → limit), NOT derived from any mirror internal. We drive every
 * optimistic mutation to ACK within each scenario, so at quiescence the pending
 * overlay is empty and oracle == pure server state.
 *
 * FAITHFUL STUB SERVER. The single most important property: PocketBase does NOT
 * replay events broadcast before a subscription is registered. The stub models
 * this precisely — an SSE op that occurs while the collection's subscription is
 * NOT yet registered is delivered to NOBODY (recoverable only by a later fetch /
 * resync). getList/getFullList/getOne reflect the server model as of when the
 * query executes. Deletes produce tombstones; a getList after a delete omits the
 * row. A disconnect→reconnect loses SSE events during the gap (no replay);
 * recovery is via resync(), which the fuzzer drives after a reconnect.
 *
 * DETERMINISTIC SCHEDULING. No real timers, no wall-clock races. fast-check
 * generates an explicit, discrete schedule of steps; the harness executes them
 * in order, flushing microtasks deterministically between steps. Registration is
 * ALWAYS resolved via the schedule, so the 10s SUBSCRIBE_READY_TIMEOUT never
 * fires (that fallback path is covered by example tests; this fuzzer is about
 * data convergence). resync is ALWAYS called with { force: true } so the
 * wall-clock coalesce window can't leak nondeterminism into assertions.
 *
 * REPRODUCIBLE + SHRINKING. fast-check arbitraries model the scenario; on failure
 * fast-check shrinks to a minimal counterexample and prints the seed + the full
 * (ops, schedule) it ran.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { clearAllMutations } from "./persistence";

// =====================================================================
// (1) THE ORACLE — independent model of server truth.
//
// This is the WHOLE VALUE of the fuzzer, so it is deliberately tiny and
// obvious. A `ServerModel` is a Map from id to the record's current server
// value, or absent (= tombstone / never existed). Every server-side op mutates
// it directly. The expected converged view for a slice is a pure function of
// this map — filter, then (for sort+limit) sort and take top-N.
//
// The oracle shares NO code with the mirror. `expectedView` re-implements the
// filter/sort/limit semantics from scratch in a handful of lines so a bug in
// the mirror's own applySort/materialize can't hide behind a shared helper.
// =====================================================================

const COLLECTION = "items";
/** The filter every wildcard/sort+limit slice uses: `list = 'L1'`. */
const FILTER_FIELD = "list";
const FILTER_VALUE = "L1";

/** A server record is a plain object; `v` is the mutable payload field, `t` is
 *  the sort key (a number), `list` is the filter field. The index signature
 *  lets it flow into the wpb write surface (Record<string, unknown>) and the
 *  loose-shaped semanticKey without casts. */
interface ServerRecord {
  id: string;
  list: string;
  v: number;
  t: number;
  [k: string]: unknown;
}

/** The oracle's view of server truth. Absent key == tombstone / never existed. */
type ServerModel = Map<string, ServerRecord>;

/** Slice shapes the fuzzer parametrizes over. */
type SliceShape =
  | { kind: "single"; id: string }
  | { kind: "filter" }
  | { kind: "sortlimit"; limit: number };

/**
 * The oracle: expected converged view for a slice, computed PURELY from the
 * final server model. Independent re-implementation of filter/sort/limit.
 *
 *   - single (topic=id): that record if present, else none.
 *   - filter: every record matching `list = 'L1'`.
 *   - sortlimit: matching records, sorted by `-t` (desc), id-tiebreak, top-N.
 */
function expectedView(model: ServerModel, shape: SliceShape): ServerRecord[] {
  if (shape.kind === "single") {
    const r = model.get(shape.id);
    return r ? [r] : [];
  }
  // filter + sortlimit both scope to list = 'L1'.
  const matching = Array.from(model.values()).filter(
    (r) => r[FILTER_FIELD] === FILTER_VALUE,
  );
  if (shape.kind === "filter") return matching;
  // sortlimit: sort by -t desc, tiebreak ascending id (matches the mirror's
  // applySort tiebreak), then take top-N.
  const sorted = matching.slice().sort((a, b) => {
    if (a.t !== b.t) return b.t - a.t; // -t (desc)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(0, shape.limit);
}

/** Semantic comparison key for one record — ignores PB autodate `updated`/
 *  `created` and collection metadata (the stub assigns those), exactly like
 *  the mirror's contentHash compares on semantic content. We compare on the
 *  fields the oracle controls: id, list, v, t. */
function semanticKey(r: ServerRecord | RawRecord): string {
  const o = r as { id: string; list?: unknown; v?: unknown; t?: unknown };
  return JSON.stringify({ id: o.id, list: o.list, v: o.v, t: o.t });
}

/** Compare an emitted view to the oracle's expected set. Order-independent for
 *  filter slices (a filter slice has no defined order); order-sensitive for
 *  sortlimit (the window order is part of the contract). single is trivially
 *  one-or-zero. */
function viewsEqual(
  emitted: RawRecord[],
  expected: ServerRecord[],
  shape: SliceShape,
): boolean {
  if (emitted.length !== expected.length) return false;
  if (shape.kind === "sortlimit") {
    // Order matters: compare positionally.
    for (let i = 0; i < emitted.length; i++) {
      if (semanticKey(emitted[i]) !== semanticKey(expected[i])) {
        return false;
      }
    }
    return true;
  }
  // single / filter: order-independent set comparison.
  const a = emitted.map((r) => semanticKey(r)).sort();
  const b = expected.map((r) => semanticKey(r)).sort();
  return a.every((k, i) => k === b[i]);
}

// =====================================================================
// (2) THE STUB SERVER — faithful PocketBase semantics.
//
// Reuses the established stub vocabulary (mirror.test.ts /
// mirror-subscribe-race.test.ts): per-collection record map + realtime callback
// set, gated reads/registration. The fidelity additions that matter:
//
//   - SSE NO-REPLAY BEFORE REGISTRATION. `registered` flips true only when the
//     schedule resolves the registration POST. An SSE op while !registered is
//     delivered to NOBODY — exactly PocketBase's behavior. (The mirror still
//     attaches its callback synchronously, but the server won't push to a
//     subscription it hasn't finished registering.)
//
//   - DISCONNECT drops `registered` back to false (SSE silent); RECONNECT does
//     NOT auto-replay — only a subsequent resync() heals the gap.
//
//   - getList/getFullList/getOne reflect the model at execution time, and
//     resolve synchronously here (the fuzzer's deterministic scheduler controls
//     ordering via explicit gating, so reads needn't be independently gated).
// =====================================================================

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubServer {
  pb: PocketBase;
  model: ServerModel;
  /** Apply a server-side op to the model AND broadcast over SSE iff registered.
   *  This is the single chokepoint a "server op" schedule step calls. */
  serverCreate: (r: ServerRecord) => void;
  serverUpdate: (id: string, patch: Partial<ServerRecord>) => void;
  serverDelete: (id: string) => void;
  /** Mark the collection's subscription registered (the schedule resolves the
   *  pending registration Promise; see registrationGate). */
  registered: () => boolean;
  resolveRegistration: () => void;
  /** Simulate an SSE drop: future server ops are NOT delivered until a
   *  reconnect re-registers. */
  disconnect: () => void;
  /** Simulate SSE reconnect: re-register (no replay of gap events). */
  reconnect: () => void;
  /** Gate ALL reads (getOne/getList/getFullList) in flight. Reads snapshot
   *  their result at CALL time (before the gate), so a fetch issued now returns
   *  the state-as-of-now even if the model is mutated while the gate is held.
   *  This is how the fuzzer creates the critical "SSE live + bootstrap fetch
   *  still in flight" pre-ready window the consolidation guards protect. */
  holdReads: () => void;
  releaseReads: () => void;
}

function makeStubServer(): StubServer {
  const model: ServerModel = new Map();
  const realtimeCbs = new Set<RealtimeCb>();
  let isRegistered = false;
  // The registration Promise the mirror's ensureCollectionListener awaits. It
  // resolves only when the schedule says so (resolveRegistration), modeling the
  // POST /api/realtime completing. Until then the slice can't go `ready`.
  let releaseRegistration: () => void = () => {};
  let registrationPromise: Promise<void> = new Promise((res) => {
    releaseRegistration = res;
  });

  // Read gate — independently of registration. When held, every read AWAITS
  // this Promise after snapshotting its result at call time.
  let readsGate: Promise<void> | null = null;
  let releaseReadsAll: () => void = () => {};

  // Realtime lifecycle plumbing for the mirror's reconnect→resync hook.
  const realtime: {
    onDisconnect?: (activeSubs: string[]) => void;
    pbConnectCbs: Set<() => void>;
  } = { onDisconnect: undefined, pbConnectCbs: new Set() };

  function toRecord(r: ServerRecord): RecordModel {
    return {
      collectionId: COLLECTION,
      collectionName: COLLECTION,
      created: "2026-01-01T00:00:00.000Z",
      // A monotonic-ish updated stamp; ignored by semantic comparison.
      updated: new Date().toISOString(),
      ...r,
    } as unknown as RecordModel;
  }

  /** Broadcast an SSE event to every registered callback — BUT only if the
   *  subscription is currently registered. Pre-registration / disconnected:
   *  delivered to nobody (PB no-replay). */
  function broadcast(action: "create" | "update" | "delete", r: ServerRecord): void {
    if (!isRegistered) return;
    const e = { action, record: toRecord(r) };
    for (const cb of Array.from(realtimeCbs)) cb(e);
  }

  const applyFilter = (r: ServerRecord, filter?: string): boolean => {
    if (!filter) return true;
    const m = filter.match(/^(\w+)\s*=\s*'([^']*)'$/);
    if (m) return (r as unknown as Record<string, unknown>)[m[1]] === m[2];
    return true;
  };
  const applySort = (records: ServerRecord[], sort?: string): ServerRecord[] => {
    if (!sort) return records;
    const parts = sort.split(",").map((p) => {
      const trimmed = p.trim();
      const desc = trimmed.startsWith("-");
      return { field: desc ? trimmed.slice(1) : trimmed, desc };
    });
    return records.slice().sort((a, b) => {
      for (const { field, desc } of parts) {
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        let cmp = 0;
        if (av === bv) cmp = 0;
        else if (av === undefined || av === null) cmp = -1;
        else if (bv === undefined || bv === null) cmp = 1;
        else if ((av as number) < (bv as number)) cmp = -1;
        else if ((av as number) > (bv as number)) cmp = 1;
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };

  const pb = {
    realtime: {
      isConnected: true,
      get onDisconnect() { return realtime.onDisconnect; },
      set onDisconnect(fn: ((activeSubs: string[]) => void) | undefined) { realtime.onDisconnect = fn; },
      async subscribe(topic: string, cb?: () => void) {
        if (topic === "PB_CONNECT" && cb) {
          realtime.pbConnectCbs.add(cb);
          return async () => { realtime.pbConnectCbs.delete(cb); };
        }
        return async () => {};
      },
      disconnect() {},
    },
    collection: (_name: string) => ({
      // ---- SSE subscription. Callback attached synchronously; registration
      // POST resolves only when the schedule releases it. ----
      async subscribe(_topic: string, cb: RealtimeCb): Promise<UnsubscribeFunc> {
        realtimeCbs.add(cb);
        await registrationPromise;
        isRegistered = true;
        return async () => { realtimeCbs.delete(cb); };
      },
      // ---- Reads snapshot at CALL time, then await the read gate. A real PB
      // query executes (sees the model) when issued, not when it resolves; so a
      // gated fetch returns pre-mutation state even if the model changes while
      // the gate is held — the mechanism that opens the "SSE live, fetch in
      // flight" pre-ready window the consolidation guards protect. ----
      async getOne(id: string): Promise<RecordModel> {
        const snapshot = model.get(id);
        if (readsGate) await readsGate;
        if (!snapshot) throw Object.assign(new Error("not found"), { status: 404 });
        return toRecord(snapshot);
      },
      async getFullList(opts?: { filter?: string }): Promise<RecordModel[]> {
        const snapshot = Array.from(model.values())
          .filter((r) => applyFilter(r, opts?.filter))
          .map(toRecord);
        if (readsGate) await readsGate;
        return snapshot;
      },
      async getList(_page: number, perPage: number, opts?: { filter?: string; sort?: string }): Promise<{ items: RecordModel[] }> {
        const all = Array.from(model.values()).filter((r) => applyFilter(r, opts?.filter));
        const snapshot = applySort(all, opts?.sort).slice(0, perPage).map(toRecord);
        if (readsGate) await readsGate;
        return { items: snapshot };
      },
      // ---- Writes (driven by wpb optimistic dispatch). These mutate the model
      // AND broadcast the SSE echo, exactly as a real PB write does. ----
      async create(body: Record<string, unknown>): Promise<RecordModel> {
        const r: ServerRecord = {
          id: body.id as string,
          list: (body.list as string) ?? FILTER_VALUE,
          v: (body.v as number) ?? 0,
          t: (body.t as number) ?? 0,
        };
        model.set(r.id, r);
        broadcast("create", r);
        return toRecord(r);
      },
      async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
        const existing = model.get(id);
        if (!existing) throw Object.assign(new Error("not found"), { status: 404 });
        const r: ServerRecord = { ...existing, ...(body as Partial<ServerRecord>) };
        model.set(id, r);
        broadcast("update", r);
        return toRecord(r);
      },
      async delete(id: string): Promise<boolean> {
        const existing = model.get(id);
        model.delete(id);
        if (existing) broadcast("delete", existing);
        return true;
      },
    }),
  } as unknown as PocketBase;

  return {
    pb,
    model,
    serverCreate(r) {
      model.set(r.id, r);
      broadcast("create", r);
    },
    serverUpdate(id, patch) {
      const existing = model.get(id);
      if (!existing) return; // update of a nonexistent id — no-op server-side.
      const next = { ...existing, ...patch };
      model.set(id, next);
      broadcast("update", next);
    },
    serverDelete(id) {
      const existing = model.get(id);
      if (!existing) return;
      model.delete(id);
      broadcast("delete", existing);
    },
    registered: () => isRegistered,
    resolveRegistration() { releaseRegistration(); },
    disconnect() { isRegistered = false; },
    reconnect() {
      // Re-arm a registration Promise so a fresh subscribe (if the mirror were
      // to re-subscribe) would await it; but the mirror keeps its existing
      // listener — flipping `isRegistered` true models the channel being live
      // again. No gap-event replay: that's the whole point of resync.
      isRegistered = true;
    },
    holdReads() {
      if (readsGate) return;
      readsGate = new Promise<void>((res) => { releaseReadsAll = res; });
    },
    releaseReads() {
      if (!readsGate) return;
      releaseReadsAll();
      readsGate = null;
    },
  };
}

// =====================================================================
// (3) MICROTASK FLUSH — deterministic settle between schedule steps.
// =====================================================================

// Microtask-based flush. The mirror's async work is entirely Promise chains
// (bootstrap, dispatch, resync) — microtasks, NOT real timers. The ONE real
// timer is the SUBSCRIBE_READY_TIMEOUT race, which the schedule never lets
// fire (registration is always resolved). So draining microtasks settles
// everything, and it's orders of magnitude faster than setTimeout(0) loops —
// keeping the whole fuzzer in the deploy gate's few-seconds budget.
async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

// =====================================================================
// (4) THE SCENARIO MODEL — fast-check arbitraries.
//
// A scenario is:
//   - a slice SHAPE (single / filter / sortlimit) + initial server records,
//   - a SCHEDULE: an explicit ordering of discrete steps the harness executes.
//
// Steps (the alphabet the scheduler interprets):
//   { t: "resolveRegistration" }     — release the SSE registration POST.
//   { t: "serverCreate", rec }       — peer/device creates a record server-side.
//   { t: "serverUpdate", id, v, time}— peer updates a record's payload/sort key.
//   { t: "serverDelete", id }        — peer deletes a record.
//   { t: "optCreate", rec }          — THIS client optimistically creates.
//   { t: "optUpdate", id, v, time }  — THIS client optimistically updates.
//   { t: "optDelete", id }           — THIS client optimistically deletes.
//   { t: "disconnect" }              — SSE drops (future server ops lost on SSE).
//   { t: "reconnect" }               — SSE returns (no replay) + drive resync.
//   { t: "flush" }                   — advance microtasks (interleave point).
//
// Small id space (4 ids) so create / overwrite / delete-then-recreate collide.
// sortlimit uses limit < record count so the window boundary is exercised.
// =====================================================================

/** Small id space — collisions are where bugs live. */
const IDS = ["a", "b", "c", "d"] as const;
type Id = (typeof IDS)[number];

type Step =
  | { t: "resolveRegistration" }
  // holdReads/releaseReads gate the bootstrap (and resync) fetches in flight.
  // Combined with resolveRegistration BEFORE releaseReads, they open the
  // critical pre-ready window: SSE live + delivering, but the bootstrap fetch
  // hasn't resolved → handleSseEvent routes events into the consolidation
  // touched-set. This is the window the `consolidated`/sseTouchedDuringBootstrap
  // fixes protect; without these steps the fuzzer can't exercise (or guard) it.
  | { t: "holdReads" }
  | { t: "releaseReads" }
  | { t: "serverCreate"; id: Id; v: number; time: number }
  | { t: "serverUpdate"; id: Id; v: number; time: number }
  | { t: "serverDelete"; id: Id }
  | { t: "optCreate"; id: Id; v: number; time: number }
  | { t: "optUpdate"; id: Id; v: number; time: number }
  | { t: "optDelete"; id: Id }
  | { t: "disconnect" }
  | { t: "reconnect" }
  | { t: "flush" };

const idArb = fc.constantFrom(...IDS);
const vArb = fc.integer({ min: 0, max: 9 });
const timeArb = fc.integer({ min: 0, max: 9 });

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ t: fc.constant("resolveRegistration" as const) }),
  fc.record({ t: fc.constant("holdReads" as const) }),
  fc.record({ t: fc.constant("releaseReads" as const) }),
  fc.record({ t: fc.constant("serverCreate" as const), id: idArb, v: vArb, time: timeArb }),
  fc.record({ t: fc.constant("serverUpdate" as const), id: idArb, v: vArb, time: timeArb }),
  fc.record({ t: fc.constant("serverDelete" as const), id: idArb }),
  fc.record({ t: fc.constant("optCreate" as const), id: idArb, v: vArb, time: timeArb }),
  fc.record({ t: fc.constant("optUpdate" as const), id: idArb, v: vArb, time: timeArb }),
  fc.record({ t: fc.constant("optDelete" as const), id: idArb }),
  fc.record({ t: fc.constant("disconnect" as const) }),
  fc.record({ t: fc.constant("reconnect" as const) }),
  fc.record({ t: fc.constant("flush" as const) }),
);

/** Initial server records present BEFORE the watch starts (the bootstrap fetch
 *  will see these). A map id→record so no dup ids. */
const initialRecordsArb = fc.uniqueArray(
  fc.record({ id: idArb, v: vArb, time: timeArb }),
  { selector: (r) => r.id, maxLength: IDS.length },
);

const shapeArb: fc.Arbitrary<SliceShape> = fc.oneof(
  fc.constant<SliceShape>({ kind: "single", id: "a" }),
  fc.constant<SliceShape>({ kind: "filter" }),
  // limit 2 with up to 4 records → window boundary is exercised.
  fc.constant<SliceShape>({ kind: "sortlimit", limit: 2 }),
);

interface Scenario {
  shape: SliceShape;
  initial: { id: Id; v: number; time: number }[];
  /**
   * When true, the harness GATES THE BOOTSTRAP FETCH from the very start (holds
   * reads before bootstrap issues its fetch) AND resolves SSE registration
   * early. This opens the bootstrap PRE-READY window — SSE live + delivering
   * while the initial fetch is still in flight — so schedule server ops land in
   * the consolidation touched-set. This is the ONLY way to exercise (and guard)
   * the `consolidated`/sseTouchedDuringBootstrap consolidation guards; a step
   * `releaseReads` (or quiescence) then resolves the stale fetch and runs
   * consolidation against it. Without this, the bootstrap fetch resolves
   * instantly before any step runs and the touched-set is never populated.
   */
  gateBootstrap: boolean;
  schedule: Step[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  shape: shapeArb,
  initial: initialRecordsArb,
  gateBootstrap: fc.boolean(),
  schedule: fc.array(stepArb, { minLength: 1, maxLength: 14 }),
});

// =====================================================================
// (5) THE HARNESS — run a scenario, drive to quiescence, assert convergence.
// =====================================================================

function watchSpecFor(shape: SliceShape) {
  if (shape.kind === "single") {
    return { collection: COLLECTION, topic: shape.id };
  }
  const base = {
    collection: COLLECTION,
    topic: "*" as const,
    filter: `${FILTER_FIELD} = '${FILTER_VALUE}'`,
    predicate: (r: RawRecord) => (r as { list?: string }).list === FILTER_VALUE,
  };
  if (shape.kind === "filter") return base;
  return { ...base, sort: "-t", limit: shape.limit };
}

/** Build a ServerRecord with the canonical list value. */
function mkRecord(id: Id, v: number, time: number): ServerRecord {
  return { id, list: FILTER_VALUE, v, t: time };
}

async function runScenario(scenario: Scenario): Promise<{ ok: boolean; detail: string }> {
  await clearAllMutations();

  const server = makeStubServer();
  const wpb = wrapPocketBase(() => server.pb);
  const mirror = createMirror(() => server.pb, wpb);

  // Seed initial server state (oracle + stub model share the same map). These
  // exist before the watch, so the bootstrap fetch sees them.
  for (const r of scenario.initial) server.model.set(r.id, mkRecord(r.id, r.v, r.time));

  // Track every emitted view per the single consumer.
  const emitted: RawRecord[][] = [];
  const handle = mirror.watch(watchSpecFor(scenario.shape), (s) => emitted.push(s));

  // Optimistic writes are AWAITED to ack before the next schedule step runs.
  // This is essential for a sound oracle: wpb.create/update/delete return a
  // Promise that resolves on ack, and the ack is when the write COMMITS
  // server-side (the stub create/update/delete mutates the model). If we left
  // these in flight, a later `serverDelete` step could interleave with an
  // un-committed optimistic create on the SAME id, so the actual server-commit
  // order would diverge from the schedule order — and the oracle (which assumes
  // schedule order == commit order) would be comparing against a timeline that
  // never happened. Awaiting makes schedule order authoritative; at quiescence
  // the pending overlay is therefore empty and oracle == pure server state.
  let disconnected = false;
  // Could the mirror have LOST any SSE event during the scenario? Two ways:
  //   (a) a disconnect (events during the gap are not delivered), or
  //   (b) a server op fired while the subscription was NOT yet registered
  //       (PB no-replay of pre-registration events — a real lost-event window).
  // Tracked for the LIVE-CHANNEL convergence checkpoint below (assertion #1):
  // when NO event was lost, the mirror must converge from bootstrap + live SSE
  // ALONE, BEFORE any resync. That is what gives the bootstrap/SSE-path guards
  // their teeth. The post-resync checkpoint (#2) is asserted unconditionally.
  let lostEvents = false;
  /** True iff an SSE broadcast right now would reach the mirror's listener. */
  const channelLive = () => server.registered();

  // gateBootstrap: hold reads + resolve registration BEFORE bootstrap issues
  // its fetch, so the bootstrap fetch stays in flight while SSE is already live.
  // Schedule server ops then land in the consolidation touched-set; a
  // `releaseReads` step (or quiescence) resolves the stale fetch and runs
  // consolidation against it — exercising the pre-ready-window guards. We hold
  // reads SYNCHRONOUSLY before the first flush so the very first bootstrap fetch
  // is gated.
  if (scenario.gateBootstrap) {
    server.holdReads();
    server.resolveRegistration();
  }

  // Let the bootstrap kick off (eager paint + fetch issue + registration
  // attach) before we start stepping. The schedule controls when registration
  // RESOLVES; until a resolveRegistration step (or the final quiescence drive),
  // the slice stays pre-ready.
  await flush();

  for (const step of scenario.schedule) {
    switch (step.t) {
      case "resolveRegistration":
        server.resolveRegistration();
        break;
      case "holdReads":
        // Gate any in-flight + future fetch. Opens the pre-ready window.
        server.holdReads();
        break;
      case "releaseReads":
        // Let the gated bootstrap/resync fetch resolve → consolidation runs
        // against a fetch result that PREDATES any SSE events delivered while
        // it was held (the touched-set window).
        server.releaseReads();
        break;
      case "serverCreate":
        // A peer/device creates (or overwrites) a record server-side. Only
        // delivered over SSE if the channel is live; otherwise the event is
        // LOST (pre-registration / disconnected) and only resync recovers it.
        if (!channelLive()) lostEvents = true;
        server.serverCreate(mkRecord(step.id, step.v, step.time));
        break;
      case "serverUpdate":
        if (!channelLive()) lostEvents = true;
        server.serverUpdate(step.id, { v: step.v, t: step.time });
        break;
      case "serverDelete":
        if (!channelLive()) lostEvents = true;
        server.serverDelete(step.id);
        break;
      case "optCreate":
        // THIS client's optimistic create. Drives the wpb write path →
        // pending overlay → POST → ack (which calls the stub create, mutating
        // the model + broadcasting the echo).
        //
        // GUARD (channelLive): only issue optimistic writes while the SSE
        // channel is live (registered + connected). When the channel is DOWN, a
        // write's own SSE echo is LOST — and the mirror has a SHIPPED bug where
        // resync then fails to reconcile that queue-only record if it's later
        // removed server-side (the "queue-only ghost" gap; see the
        // `it.fails` regression below + the report). We deliberately do NOT
        // generate that interleaving here so the property guards everything
        // ELSE without going red on a known, separately-tracked defect. Remove
        // this guard once resync's reconcile is fixed to scan the queue layer,
        // not just slice.records — the regression test will then flip to green.
        if (server.registered()) {
          await wpb.collection(COLLECTION).create(mkRecord(step.id, step.v, step.time)).catch(() => {});
          await flush();
        }
        break;
      case "optUpdate":
        if (server.registered()) {
          await wpb.collection(COLLECTION).update(step.id, { v: step.v, t: step.time }).catch(() => {});
          await flush();
        }
        break;
      case "optDelete":
        if (server.registered()) {
          await wpb.collection(COLLECTION).delete(step.id).catch(() => {});
          await flush();
        }
        break;
      case "disconnect":
        server.disconnect();
        disconnected = true;
        lostEvents = true;
        break;
      case "reconnect":
        // Reconnect implies the network is back — release any read gate so the
        // resync fetch can resolve, then heal the gap. The app drives resync()
        // on reconnect (force bypasses the wall-clock coalesce window for
        // determinism).
        server.releaseReads();
        server.reconnect();
        await flush();
        await mirror.resync({ force: true });
        disconnected = false;
        break;
      case "flush":
        await flush(2);
        break;
    }
    // Settle each step's microtasks so ordering between steps is deterministic.
    await flush(2);
  }

  // ── DRIVE TO QUIESCENCE ──────────────────────────────────────────────
  // 0. Release any held read gate so the bootstrap/resync fetch can resolve.
  server.releaseReads();
  await flush();
  // 1. Resolve registration if the schedule never did (so the slice goes
  //    ready and the bootstrap force-emit lands).
  server.resolveRegistration();
  await flush();
  // 2. (Optimistic writes were already awaited to ack inline, so the pending
  //    overlay is empty here and oracle == pure server state.)

  const expected = expectedView(server.model, scenario.shape);

  // ── CHECKPOINT #1 — LIVE-CHANNEL CONVERGENCE (no resync) ──────────────
  // When NO SSE event was ever lost (channel live throughout — e.g. a pure
  // bootstrap-pre-ready-window scenario), the mirror MUST already match the
  // oracle from bootstrap + live SSE ALONE, BEFORE any resync. This is where
  // the bootstrap-consolidation / SSE-path guards (consolidated,
  // sseTouchedDuringBootstrap, sort+limit window) get their teeth: resync is a
  // big hammer that would heal almost anything, so we forbid it here. Sort+limit
  // is EXEMPT from this strict checkpoint pending a shipped under-fill bug the
  // fuzzer found (a pre-ready event that DEMOTES a windowed record doesn't
  // trigger the backfill refetch — see the `it.fails` regression). filter +
  // single must converge live.
  const liveLast = emitted.length > 0 ? emitted[emitted.length - 1] : [];
  const liveCheckApplies = !lostEvents && scenario.shape.kind !== "sortlimit";
  const liveOk = !liveCheckApplies || viewsEqual(liveLast, expected, scenario.shape);

  // ── CHECKPOINT #2 — POST-RESYNC CONVERGENCE (the app's true guarantee) ──
  // The app ALWAYS has resync available (focus / PB_CONNECT). So the realistic
  // convergence guarantee is the post-resync state: whatever bootstrap/SSE
  // missed, resync heals. Always drive a final reconnect+resync, then assert.
  // This is what the queue-only-ghost regression shows resync FAILS to do for a
  // queue-only record — that interleaving is excluded from the property (see
  // the channelLive write guard) and captured in its own `it.fails`.
  server.reconnect();
  await flush();
  await mirror.resync({ force: true });
  await flush();
  // One more settle for any refetch-driven emit (sort+limit window refill).
  await flush();

  handle.unsubscribe();

  const postLast = emitted.length > 0 ? emitted[emitted.length - 1] : [];
  const postOk = viewsEqual(postLast, expected, scenario.shape);

  const ok = liveOk && postOk;

  const detail = [
    `shape=${JSON.stringify(scenario.shape)}`,
    `gateBootstrap=${scenario.gateBootstrap}`,
    `lostEvents=${lostEvents} disconnectedAtEnd=${disconnected}`,
    `liveCheckApplies=${liveCheckApplies} liveOk=${liveOk} postOk=${postOk}`,
    `finalModel=${JSON.stringify(Array.from(server.model.values()))}`,
    `expected=${JSON.stringify(expected)}`,
    `liveEmitted=${JSON.stringify(liveLast)}`,
    `postEmitted=${JSON.stringify(postLast)}`,
    `emitCount=${emitted.length}`,
  ].join("\n  ");

  return { ok, detail };
}

// =====================================================================
// (6) THE PROPERTY.
// =====================================================================

beforeEach(async () => {
  await clearAllMutations();
});

describe("PBMirror convergence fuzzer", () => {
  it("converges to the oracle view for every interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { ok, detail } = await runScenario(scenario);
        if (!ok) {
          // fast-check shrinks; this message prints the minimal counterexample.
          throw new Error(`mirror diverged from oracle:\n  ${detail}`);
        }
      }),
      {
        // Bounded for the deploy gate: ~1k cases settle in ~1s (each case
        // drives many microtask flushes + a full bootstrap/resync). Seeded for
        // reproducibility — a failure reproduces with the printed seed.
        // Validated green across seeds {0x5eed,777,1,42,99999,12345,0xbeef,555}
        // at 2k each and at 5k on the default seed.
        numRuns: 1000,
        seed: 0x5eed,
      },
    );
  }, 30000);
});

// =====================================================================
// (7) KNOWN-BUG REGRESSION — the queue-only-ghost convergence gap.
//
// The fuzzer found a REAL, shipped convergence gap (reported prominently in the
// task summary). The property above deliberately excludes this interleaving
// (via the `server.registered()` guard on optimistic writes) so it can guard
// everything else green in the deploy gate. This `it.fails` block pins the bug
// as a reproducible, named spec so it is NOT lost and so the day resync's
// reconcile is fixed, this test flips to a hard failure (forcing the author to
// delete `.fails` + the guard above, re-enabling full optimistic-during-down
// fuzzing).
//
// THE GAP: for a filter-only wildcard slice, an optimistically-created+acked
// record whose SSE echo was LOST (created while the channel was down /
// pre-registration) enters the mutation QUEUE but never enters `slice.records`
// (only handleSseEvent populates that, and the echo was dropped). resync's
// ghost-reconcile loop scans ONLY `slice.records.keys()` — so if that record is
// later removed server-side (a removal also unseen over the dead SSE), resync's
// getFullList returns without it, yet resync never tombstones it (it's not in
// slice.records). Because filter-slice materialize() reads the whole
// queue.viewCollection, the ghost lingers in the emitted view forever.
//
// FIX DIRECTION (not applied — left to the owner's call): resync's reconcile
// must scan the queue's server-backed records matching the slice predicate, not
// just slice.records — i.e. tombstone any queue record that matches the slice,
// has a server snapshot, has no pending mutation, and is absent from the fresh
// fetch. (bootstrap's reconcileGhosts has the same slice.records-only shape but
// is sound there because bootstrap seeds slice.records from the queue first.)
// =====================================================================

describe("PBMirror convergence — KNOWN BUG (queue-only ghost)", () => {
  it.fails(
    "resync does NOT reconcile a queue-only optimistic record removed while SSE was down",
    async () => {
      const scenario: Scenario = {
        shape: { kind: "filter" },
        initial: [],
        gateBootstrap: false,
        schedule: [
          // optCreate fires PRE-registration (no resolveRegistration before it),
          // so its SSE echo is lost; then the record is deleted server-side
          // (also unseen). At quiescence resync should heal to [] but doesn't.
          { t: "optCreate", id: "d", v: 0, time: 0 },
          { t: "serverDelete", id: "d" },
        ],
      };
      // NOTE: runScenario's `server.registered()` guard SKIPS the pre-reg
      // optCreate, so to actually exercise the bug we bypass the guard here by
      // driving the minimal sequence inline. Kept faithful to the harness.
      const { ok } = await runQueueOnlyGhostBug(scenario);
      // Assert convergence — this SHOULD pass once fixed; today it FAILS,
      // which `it.fails` asserts (the test passes BECAUSE the body throws).
      expect(ok, "mirror should converge to [] after resync").toBe(true);
    },
  );
});

/** Inline driver for the queue-only-ghost bug that does NOT apply the
 *  optimistic-write channel-live guard — so the lost-echo optimistic create is
 *  actually issued. Mirrors runScenario's quiescence drive. */
async function runQueueOnlyGhostBug(scenario: Scenario): Promise<{ ok: boolean }> {
  await clearAllMutations();
  const server = makeStubServer();
  const wpb = wrapPocketBase(() => server.pb);
  const mirror = createMirror(() => server.pb, wpb);

  const emitted: RawRecord[][] = [];
  const handle = mirror.watch(watchSpecFor(scenario.shape), (s) => emitted.push(s));
  await flush();

  // Pre-registration optimistic create — echo lost. Drive to ack.
  await wpb.collection(COLLECTION).create(mkRecord("d", 0, 0)).catch(() => {});
  await flush();
  // Server removes it (also unseen over the dead/unregistered SSE).
  server.serverDelete("d");
  await flush();

  // Quiescence: register, reconnect, resync.
  server.resolveRegistration();
  await flush();
  server.reconnect();
  await flush();
  await mirror.resync({ force: true });
  await flush();
  handle.unsubscribe();

  const expected = expectedView(server.model, scenario.shape); // []
  const last = emitted.length > 0 ? emitted[emitted.length - 1] : [];
  return { ok: viewsEqual(last, expected, scenario.shape) };
}

// =====================================================================
// (8) KNOWN-BUG REGRESSION #2 — sort+limit pre-ready DEMOTION under-fill.
//
// The fuzzer's LIVE-CHANNEL checkpoint (#1) exempts the sortlimit shape because
// of this second shipped bug it surfaced. THE GAP: during the bootstrap
// pre-ready window (SSE live, fetch in flight), an SSE event that DEMOTES a
// windowed record out of the top-N — e.g. an update lowering its sort key —
// vacates a window slot, but the mirror only arms a backfill refetch for
// pre-ready DELETEs (windowDeletedIds). The mirror's own comment asserts
// "creates/updates never under-fill", which is FALSE for a demotion: the
// below-window record that should promote into the vacated slot is never
// fetched, so the window renders the demoted record instead of the promotion
// until the next resync.
//
// Realizable on a flaky connection where the SSE registration POST lags the
// initial fetch and a peer demotes a top-N row in that window. Resync heals it
// (so checkpoint #2 stays green), but the LIVE convergence is wrong.
//
// FIX DIRECTION (not applied): in handleSseEvent / bootstrap, treat a pre-ready
// event that drops a record's rank below the current top-N like a window
// vacancy — arm the same post-consolidation backfill refetch
// (scheduleRefetch) that pre-ready DELETEs already trigger.
// =====================================================================

describe("PBMirror convergence — KNOWN BUG (sort+limit pre-ready demotion)", () => {
  it.fails(
    "a pre-ready demotion out of the top-N does not backfill the promoted record",
    async () => {
      await clearAllMutations();
      const server = makeStubServer();
      const wpb = wrapPocketBase(() => server.pb);
      const mirror = createMirror(() => server.pb, wpb);

      // a,c,d all t=1; limit 2 → server top-2 = [a,c] (id tiebreak), d below.
      server.model.set("a", mkRecord("a", 0, 1));
      server.model.set("c", mkRecord("c", 0, 1));
      server.model.set("d", mkRecord("d", 0, 1));

      const emitted: RawRecord[][] = [];
      const handle = mirror.watch(
        watchSpecFor({ kind: "sortlimit", limit: 2 }),
        (s) => emitted.push(s),
      );

      // Gate the bootstrap fetch + resolve registration → SSE live, fetch in
      // flight (the pre-ready window).
      server.holdReads();
      server.resolveRegistration();
      await flush();

      // Pre-ready SSE: demote `a` to t=0 → it should leave the top-2 and `d`
      // should promote. (serverUpdate broadcasts the SSE update into the window.)
      server.serverUpdate("a", { t: 0 });
      await flush();

      // Resolve the gated bootstrap fetch (stale top-2 = [a,c]) + consolidation.
      server.releaseReads();
      await flush();

      handle.unsubscribe();

      // No lost events, no resync. Expected top-2 = [c(t1), d(t1)].
      const expected = expectedView(server.model, { kind: "sortlimit", limit: 2 });
      const last = emitted.length > 0 ? emitted[emitted.length - 1] : [];
      expect(
        viewsEqual(last, expected, { kind: "sortlimit", limit: 2 }),
        "sort+limit window should backfill the promoted record after a pre-ready demotion",
      ).toBe(true);
    },
  );
});
