import { describe, it, expect } from "vitest";
import { MutationQueue, composeView, HYDRATED_SEQ, type RawRecord } from "./queue";

const r = (id: string, fields: Record<string, unknown> = {}): RawRecord => ({ id, ...fields });

describe("composeView", () => {
  it("returns null when no server and no pending", () => {
    expect(composeView(null, [])).toBeNull();
  });

  it("returns server snapshot when no pending", () => {
    expect(composeView(r("a", { name: "x" }), [])).toEqual({ id: "a", name: "x" });
  });

  it("Set is a no-op when a server snapshot already exists (server truth wins)", () => {
    // A `set` mutation models an optimistic create. Once the server has a
    // snapshot for this id, the create has either already landed (set is
    // moot; pending drains on ack) or pre-existed (set will 409 and drain
    // via permanent-error path). In neither case may the set's stale
    // create-time body override fresher server truth — this is the
    // dogfood oscillation root cause (realworld.test.ts:A11).
    expect(
      composeView(r("a", { name: "x" }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "y" }) } },
      ]),
    ).toEqual({ id: "a", name: "x" });
  });

  it("Set on null server produces the set body (optimistic-create overlay)", () => {
    expect(
      composeView(null, [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "y" }) } },
      ]),
    ).toEqual({ id: "a", name: "y" });
  });

  it("Set followed by Update on null server folds correctly", () => {
    expect(
      composeView(null, [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "y", count: 1 }) } },
        { id: "m2", collection: "c", recordId: "a", createdAt: 1, mutation: { kind: "update", patch: { count: 2 } } },
      ]),
    ).toEqual({ id: "a", name: "y", count: 2 });
  });

  it("Set is no-op on server, but subsequent Update still merges on server", () => {
    // Sanity: even when set is no-op'd, downstream updates still apply.
    // This is what makes the optimistic-write chain converge after server
    // truth arrives mid-flight.
    expect(
      composeView(r("a", { name: "server", count: 99 }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "stale-create", count: 1 }) } },
        { id: "m2", collection: "c", recordId: "a", createdAt: 1, mutation: { kind: "update", patch: { count: 2 } } },
      ]),
    ).toEqual({ id: "a", name: "server", count: 2 });
  });

  it("Update merges patch onto server", () => {
    expect(
      composeView(r("a", { name: "x", note: "n" }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "update", patch: { name: "y" } } },
      ]),
    ).toEqual({ id: "a", name: "y", note: "n" });
  });

  it("Update on null returns null (no record to patch)", () => {
    expect(
      composeView(null, [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "update", patch: { name: "y" } } },
      ]),
    ).toBeNull();
  });

  it("Delete returns null", () => {
    expect(
      composeView(r("a", { name: "x" }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "delete" } },
      ]),
    ).toBeNull();
  });

  it("Set then Update folds in order", () => {
    expect(
      composeView(null, [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "x" }) } },
        { id: "m2", collection: "c", recordId: "a", createdAt: 1, mutation: { kind: "update", patch: { name: "y" } } },
      ]),
    ).toEqual({ id: "a", name: "y" });
  });

  it("Update then Update applies in sequence", () => {
    expect(
      composeView(r("a", { name: "x", count: 1 }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "update", patch: { count: 2 } } },
        { id: "m2", collection: "c", recordId: "a", createdAt: 1, mutation: { kind: "update", patch: { name: "y" } } },
      ]),
    ).toEqual({ id: "a", name: "y", count: 2 });
  });

  it("Delete then Set produces the Set record", () => {
    expect(
      composeView(r("a", { name: "x" }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "delete" } },
        { id: "m2", collection: "c", recordId: "a", createdAt: 1, mutation: { kind: "set", record: r("a", { name: "z" }) } },
      ]),
    ).toEqual({ id: "a", name: "z" });
  });
});

describe("MutationQueue", () => {
  it("view returns null for unknown record", () => {
    const q = new MutationQueue();
    expect(q.view("c", "missing")).toBeNull();
  });

  it("applyServer + view shows server snapshot", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    expect(q.view("c", "a")).toEqual({ id: "a", name: "x" });
  });

  it("pushPending overlays on server snapshot", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.pushPending("c", "a", { kind: "update", patch: { name: "y" } }, "m1");
    expect(q.view("c", "a")).toEqual({ id: "a", name: "y" });
  });

  it("drainPending removes the matching mutation", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.pushPending("c", "a", { kind: "update", patch: { name: "y" } }, "m1");
    const result = q.drainPending("c", "a", "m1");
    expect(result.found).toBe(true);
    expect(q.view("c", "a")).toEqual({ id: "a", name: "x" });
  });

  it("drainPending of unknown id is a no-op", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    const result = q.drainPending("c", "a", "unknown");
    expect(result.found).toBe(false);
    expect(q.view("c", "a")).toEqual({ id: "a", name: "x" });
  });

  it("pending Set on a missing record makes view non-null", () => {
    const q = new MutationQueue();
    q.pushPending("c", "a", { kind: "set", record: r("a", { name: "new" }) }, "m1");
    expect(q.view("c", "a")).toEqual({ id: "a", name: "new" });
  });

  it("pending Delete after server hides the record", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.pushPending("c", "a", { kind: "delete" }, "m1");
    expect(q.view("c", "a")).toBeNull();
  });

  it("draining a Delete brings the server record back", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.pushPending("c", "a", { kind: "delete" }, "m1");
    expect(q.view("c", "a")).toBeNull();
    q.drainPending("c", "a", "m1");
    expect(q.view("c", "a")).toEqual({ id: "a", name: "x" });
  });

  it("server tombstone (null) makes the record invisible (retained as a tombstone)", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.applyServer("c", "a", null);
    // The view is null and viewCollection excludes it — observable behavior is
    // "gone". The ENTRY is retained (a tombstone with its seq) so it can
    // out-rank a stale fetch; GC reclaims it later. hasServerSnapshot is false.
    expect(q.view("c", "a")).toBeNull();
    expect(q.viewCollection("c")).toEqual([]);
    expect(q.hasServerSnapshot("c", "a")).toBe(false);
    expect(q.serverSeqOf("c", "a")).toBeGreaterThan(0); // retained tombstone
  });

  it("viewCollection returns visible records", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { list: "x" }));
    q.applyServer("c", "b", r("b", { list: "y" }));
    q.applyServer("c", "c", r("c", { list: "x" }));
    expect(q.viewCollection("c").map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("viewCollection respects predicate", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { list: "x" }));
    q.applyServer("c", "b", r("b", { list: "y" }));
    expect(
      q.viewCollection("c", (r) => r.list === "x").map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("viewCollection excludes records with active Delete pending", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { list: "x" }));
    q.applyServer("c", "b", r("b", { list: "x" }));
    q.pushPending("c", "a", { kind: "delete" }, "m1");
    expect(q.viewCollection("c").map((r) => r.id)).toEqual(["b"]);
  });

  it("allPending sorts by createdAt", async () => {
    const q = new MutationQueue();
    q.pushPending("c", "a", { kind: "set", record: r("a") }, "m1");
    // Force createdAt to differ
    await new Promise((r) => setTimeout(r, 2));
    q.pushPending("c", "b", { kind: "set", record: r("b") }, "m2");
    const all = q.allPending();
    expect(all.map((p) => p.id)).toEqual(["m1", "m2"]);
  });

  it("server event for a record with pending mutation keeps the pending overlay", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "server-1" }));
    q.pushPending("c", "a", { kind: "update", patch: { name: "optimistic" } }, "m1");
    // Foreign server change arrives — pending should still overlay
    q.applyServer("c", "a", r("a", { name: "server-2", note: "added" }));
    expect(q.view("c", "a")).toEqual({ id: "a", name: "optimistic", note: "added" });
  });
});

// =====================================================================
// The SEQ model — monotonic server-observation versioning. These assert the
// structural invariant directly (the fuzzer guards it black-box; these pin the
// queue API the mirror's seq plumbing leans on).
// =====================================================================
describe("applyServer monotonicity (seq)", () => {
  it("a STALE fetch row never overwrites a NEWER SSE value", () => {
    const q = new MutationQueue();
    // Model: a fetch is ISSUED (seq taken), then an SSE event arrives (higher
    // seq), then the older fetch resolves and tries to seed its stale row.
    const fetchSeq = q.nextSeq();      // 1 — fetch issued
    const sseSeq = q.nextSeq();        // 2 — SSE arrives after the fetch issued
    q.applyServer("c", "a", r("a", { v: 2 }), sseSeq);   // SSE applies v=2
    const res = q.applyServer("c", "a", r("a", { v: 1 }), fetchSeq); // stale fetch seed
    expect(res.changed, "stale fetch row must be rejected").toBe(false);
    expect(q.view("c", "a")).toEqual({ id: "a", v: 2 }); // newer SSE wins
  });

  it("a RETAINED TOMBSTONE out-ranks a stale fetch row (no resurrection)", () => {
    const q = new MutationQueue();
    const fetchSeq = q.nextSeq();      // 1 — fetch issued (will carry the row)
    const delSeq = q.nextSeq();        // 2 — SSE DELETE after the fetch issued
    q.applyServer("c", "a", r("a", { v: 1 }), HYDRATED_SEQ); // pre-existing
    q.applyServer("c", "a", null, delSeq);                          // tombstone @2
    const res = q.applyServer("c", "a", r("a", { v: 1 }), fetchSeq); // stale fetch @1
    expect(res.changed, "stale fetch must not resurrect the deleted record").toBe(false);
    expect(q.view("c", "a"), "record stays deleted").toBeNull();
  });

  it("hydration (HYDRATED_SEQ) is the oldest observation — any real fetch overwrites it", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { v: "cached" }), 0); // HYDRATED_SEQ
    expect(q.serverSeqOf("c", "a")).toBe(0);
    const res = q.applyServer("c", "a", r("a", { v: "fresh" }), q.nextSeq());
    expect(res.changed).toBe(true);
    expect(q.view("c", "a")).toEqual({ id: "a", v: "fresh" });
  });
});

describe("tombstone GC (bounded retention)", () => {
  it("a tombstone survives while an OLDER fetch is in flight, then is dropped", () => {
    const q = new MutationQueue();
    // An older fetch is in flight (issued at seq 1).
    const fetchSeq = q.nextSeq();          // 1
    const token = q.noteFetchIssued(fetchSeq);
    // A delete observed later (seq 2) writes a retained tombstone.
    const delSeq = q.nextSeq();            // 2
    q.applyServer("c", "a", r("a"), 0);    // pre-existing (hydrated)
    q.applyServer("c", "a", null, delSeq); // tombstone @2
    // While the seq-1 fetch is in flight, the tombstone MUST be retained so the
    // fetch's stale row can't resurrect 'a'. Resolving the fetch GC's it.
    q.noteFetchResolved(token);
    // The tombstone is now safe to drop (no fetch older than seq 2 in flight) —
    // a brand-new entry would be created fresh on the next observation.
    expect(q.serverSeqOf("c", "a")).toBe(0); // entry GC'd → reports default 0
  });

  it("GC never drops a tombstone that still has pending", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a"), 0);
    const delSeq = q.nextSeq();
    q.applyServer("c", "a", null, delSeq);          // tombstone
    q.pushPending("c", "a", { kind: "set", record: r("a", { v: "recreate" }) }, "m1");
    // No fetch in flight ⇒ GC would otherwise drop the tombstone. It must NOT,
    // because pending still needs the slot (the optimistic recreate overlay).
    q.noteFetchResolved(q.noteFetchIssued(q.nextSeq()));
    expect(q.view("c", "a"), "pending overlay (recreate) survives GC").toEqual({ id: "a", v: "recreate" });
  });

  it("GC keeps a tombstone while ANY older-or-equal fetch is still in flight", () => {
    const q = new MutationQueue();
    const olderFetch = q.nextSeq();        // 1
    const tokA = q.noteFetchIssued(olderFetch);
    const delSeq = q.nextSeq();            // 2 — tombstone
    q.applyServer("c", "a", r("a"), 0);
    q.applyServer("c", "a", null, delSeq);
    // A second, NEWER fetch issues + resolves while the older one is still in
    // flight. GC runs on its resolve but must NOT drop the tombstone (the older
    // seq-1 fetch could still try to seed a stale row).
    const newerFetch = q.nextSeq();        // 3
    const tokB = q.noteFetchIssued(newerFetch);
    q.noteFetchResolved(tokB);
    // Stale older fetch row arrives — tombstone must still reject it.
    const res = q.applyServer("c", "a", r("a", { v: 1 }), olderFetch);
    expect(res.changed, "older in-flight fetch's stale row still rejected").toBe(false);
    expect(q.view("c", "a")).toBeNull();
    q.noteFetchResolved(tokA);
  });
});
