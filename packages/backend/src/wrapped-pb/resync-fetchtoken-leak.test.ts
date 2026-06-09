import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "./index";
import { createMirror, type RawRecord } from "./mirror";
import { clearAllMutations } from "./persistence";

// Probe: does a non-404 getOne error during a SINGLE-RECORD resync leak the
// in-flight fetch token (mirror.ts:1311 inner-catch `return`)? If it does, the
// leaked seq pins min(inFlightFetchSeqs) forever, so a tombstone written later
// can never be GC'd -> unbounded growth.

function toRecord(r: Record<string, unknown>): RecordModel {
  return {
    collectionId: "c", collectionName: "c",
    created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
    ...r,
  } as unknown as RecordModel;
}

async function flush(n = 12) { for (let i = 0; i < n; i++) await Promise.resolve(); }

describe("leak probe: single-record resync non-404 error", () => {
  it("does not leak the in-flight fetch token (tombstone GC stays unblocked)", async () => {
    await clearAllMutations();

    let getOneMode: "ok" | "error500" = "ok";
    const realtimeCbs = new Set<(e: { action: string; record: RecordModel }) => void>();

    const pb = {
      realtime: {
        isConnected: true,
        onDisconnect: undefined as unknown,
        async subscribe(topic: string, cb?: () => void): Promise<UnsubscribeFunc> {
          if (topic === "PB_CONNECT") return async () => {};
          return async () => {};
        },
        disconnect() {},
      },
      collection: () => ({
        async subscribe(_t: string, cb: (e: { action: string; record: RecordModel }) => void): Promise<UnsubscribeFunc> {
          realtimeCbs.add(cb);
          return async () => { realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          if (getOneMode === "error500") {
            throw Object.assign(new Error("server error"), { status: 500 });
          }
          return toRecord({ id, v: 1 });
        },
        async getList() { return { items: [] }; },
        async getFullList() { return []; },
        async create(body: Record<string, unknown>) { return toRecord(body); },
        async update(id: string, body: Record<string, unknown>) { return toRecord({ id, ...body }); },
        async delete() { return true; },
      }),
    } as unknown as PocketBase;

    const wpb = wrapPocketBase(() => pb);
    const mirror = createMirror(() => pb, wpb);

    // Single-record watch on "x".
    const emitted: RawRecord[][] = [];
    mirror.watch({ collection: "c", topic: "x" }, (s) => emitted.push(s));
    await flush();

    // Now the server starts erroring on getOne. Drive a resync — this issues a
    // fetch token, getOne 500s, inner-catch returns WITHOUT noteFetchResolved.
    getOneMode = "error500";
    await mirror.resync({ force: true });
    await flush();

    // Access the queue's private inFlightFetchSeqs via the mirror integration.
    const q = (wpb as unknown as { mirrorIntegration: { queue: unknown } }).mirrorIntegration.queue;
    const inFlight = (q as unknown as { inFlightFetchSeqs: Map<number, number> }).inFlightFetchSeqs;

    // If the token leaked, inFlight is non-empty AFTER the resync settled.
    expect(inFlight.size).toBe(0);
  });

  it("leaked token permanently blocks tombstone GC -> unbounded growth", async () => {
    await clearAllMutations();
    let getOneMode: "ok" | "error500" = "ok";
    const pb = {
      realtime: {
        isConnected: true, onDisconnect: undefined as unknown,
        async subscribe(): Promise<UnsubscribeFunc> { return async () => {}; },
        disconnect() {},
      },
      collection: () => ({
        async subscribe(): Promise<UnsubscribeFunc> { return async () => {}; },
        async getOne(id: string): Promise<RecordModel> {
          if (getOneMode === "error500") throw Object.assign(new Error("e"), { status: 500 });
          return toRecord({ id, v: 1 });
        },
        async getList() { return { items: [] }; },
        async getFullList() { return []; },
        async create(b: Record<string, unknown>) { return toRecord(b); },
        async update(id: string, b: Record<string, unknown>) { return toRecord({ id, ...b }); },
        async delete() { return true; },
      }),
    } as unknown as PocketBase;

    const wpb = wrapPocketBase(() => pb);
    const mirror = createMirror(() => pb, wpb);
    // single-record watch on "x" so a single-record resync runs and leaks.
    mirror.watch({ collection: "c", topic: "x" }, () => {});
    await flush();
    getOneMode = "error500";
    await mirror.resync({ force: true }); // leaks the token (seq pinned low)
    await flush();

    const q = (wpb as unknown as { mirrorIntegration: { queue: { applyServer: Function; noteFetchIssued: Function; noteFetchResolved: Function; nextSeq: Function; } } }).mirrorIntegration.queue;
    const state = (q as unknown as { state: Map<string, Map<string, unknown>> }).state;

    // Now simulate a long-lived slice with steady delete churn (tombstones at
    // ever-higher seqs) on a DIFFERENT collection, with a fetch issued+resolved
    // around each (the normal drain trigger). They should drain to 0; the leaked
    // token from the OTHER collection pins min and prevents it.
    for (let i = 0; i < 50; i++) {
      const seq = q.nextSeq();
      q.applyServer("other", `t${i}`, null, seq); // tombstone
      const tok = q.noteFetchIssued(q.nextSeq());
      q.noteFetchResolved(tok); // would normally GC all unneeded tombstones
    }
    const otherCol = state.get("other") as Map<string, unknown> | undefined;
    // With the leak fixed these would all be GC'd (min = +Inf). With the leak,
    // every tombstone with seq > leakedSeq survives forever.
    expect(otherCol?.size ?? 0).toBe(0);
  });
});
