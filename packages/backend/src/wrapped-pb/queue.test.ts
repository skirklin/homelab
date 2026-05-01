import { describe, it, expect } from "vitest";
import { MutationQueue, composeView, type RawRecord } from "./queue";

const r = (id: string, fields: Record<string, unknown> = {}): RawRecord => ({ id, ...fields });

describe("composeView", () => {
  it("returns null when no server and no pending", () => {
    expect(composeView(null, [])).toBeNull();
  });

  it("returns server snapshot when no pending", () => {
    expect(composeView(r("a", { name: "x" }), [])).toEqual({ id: "a", name: "x" });
  });

  it("Set replaces server", () => {
    expect(
      composeView(r("a", { name: "x" }), [
        { id: "m1", collection: "c", recordId: "a", createdAt: 0, mutation: { kind: "set", record: r("a", { name: "y" }) } },
      ]),
    ).toEqual({ id: "a", name: "y" });
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

  it("server tombstone (null) removes record entirely once queue is empty", () => {
    const q = new MutationQueue();
    q.applyServer("c", "a", r("a", { name: "x" }));
    q.applyServer("c", "a", null);
    expect(q.view("c", "a")).toBeNull();
    expect(q.viewCollection("c")).toEqual([]);
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
