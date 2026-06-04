/**
 * PocketBaseTravelBackend — travel_notes (per-user feedback) tests.
 *
 * Unit-level, against a stub PocketBase (same pattern as recipes.test.ts).
 * Covers the Phase-2 backend layer for travel_notes:
 *   - addNote stamps created_by from the caller-supplied userId
 *   - getNotes returns newest-first (sorted on `created`)
 *   - updateNote replaces the entries array wholesale
 *   - deleteNote removes the row
 *   - the log-level mirror slice surfaces a note through subscribeToLog's
 *     onNotes handler (the day_entries precedent — notes load with the log)
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "../wrapped-pb";
import { createMirror } from "../wrapped-pb/mirror";
import { clearAllMutations } from "../wrapped-pb/persistence";
import { PocketBaseTravelBackend } from "./travel";
import type { LifeEntry } from "../types/life";

type RealtimeCb = (e: { action: string; record: RecordModel }) => void;

interface StubCollection {
  records: Map<string, RecordModel>;
  realtimeCbs: Set<RealtimeCb>;
}

function makeStubPb(): {
  pb: PocketBase;
  col: (n: string) => StubCollection;
} {
  const cols = new Map<string, StubCollection>();
  const get = (n: string): StubCollection => {
    let c = cols.get(n);
    if (!c) {
      c = { records: new Map(), realtimeCbs: new Set() };
      cols.set(n, c);
    }
    return c;
  };

  const stub = {
    filter: (expr: string, params: Record<string, string>) => {
      let out = expr;
      for (const [k, v] of Object.entries(params)) out = out.replace(`{:${k}}`, v);
      return out;
    },
    realtime: {
      onDisconnect: undefined,
      async subscribe(topic: string) {
        if (topic === "PB_CONNECT") return async () => {};
        return async () => {};
      },
    },
    collection: (name: string) => {
      const c = get(name);
      return {
        async create(body: Record<string, unknown>): Promise<RecordModel> {
          const id = (body.id as string) ?? `rand-${Math.random()}`;
          const now = new Date().toISOString();
          const record = { id, collectionId: name, collectionName: name, created: now, updated: now, ...body } as unknown as RecordModel;
          c.records.set(id, record);
          return record;
        },
        async update(id: string, body: Record<string, unknown>): Promise<RecordModel> {
          const existing = c.records.get(id) ?? ({ id } as unknown as RecordModel);
          const updated = { ...existing, ...body, updated: new Date().toISOString() } as RecordModel;
          c.records.set(id, updated);
          return updated;
        },
        async delete(id: string): Promise<boolean> {
          c.records.delete(id);
          return true;
        },
        async subscribe(_topic: string, cb: RealtimeCb): Promise<UnsubscribeFunc> {
          c.realtimeCbs.add(cb);
          return async () => { c.realtimeCbs.delete(cb); };
        },
        async getOne(id: string): Promise<RecordModel> {
          const r = c.records.get(id);
          if (!r) throw Object.assign(new Error("not found"), { status: 404 });
          return r;
        },
        async getFullList(): Promise<RecordModel[]> {
          return Array.from(c.records.values());
        },
        async getList(): Promise<{ items: RecordModel[] }> {
          return { items: Array.from(c.records.values()) };
        },
        async getFirstListItem(): Promise<RecordModel> {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      };
    },
  } as unknown as PocketBase;

  return { pb: stub, col: get };
}

function drain(): Promise<void> {
  return new Promise<void>(async (resolve) => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    resolve();
  });
}

/** Directly seed a travel_notes row with explicit created timestamp + entries. */
function seedNote(
  stub: ReturnType<typeof makeStubPb>,
  id: string,
  logId: string,
  subjectType: string,
  subjectId: string,
  created: string,
  entries: LifeEntry[],
  createdBy = "u1",
): void {
  stub.col("travel_notes").records.set(id, {
    id,
    collectionId: "travel_notes",
    collectionName: "travel_notes",
    created,
    updated: created,
    log: logId,
    subject_type: subjectType,
    subject_id: subjectId,
    created_by: createdBy,
    entries,
  } as unknown as RecordModel);
}

const textEntry = (value: string): LifeEntry => ({ name: "note", type: "text", value });

beforeEach(async () => {
  await clearAllMutations();
});

describe("PocketBaseTravelBackend — travel_notes", () => {
  it("addNote stamps created_by from the caller-supplied userId", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const travel = new PocketBaseTravelBackend(() => stub.pb, wpb, mirror);

    const id = await travel.addNote("L1", "activity", "A1", "u42", [textEntry("loved it")]);
    await drain();

    const row = stub.col("travel_notes").records.get(id) as unknown as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.created_by).toBe("u42");
    expect(row.log).toBe("L1");
    expect(row.subject_type).toBe("activity");
    expect(row.subject_id).toBe("A1");
    expect(row.entries).toEqual([textEntry("loved it")]);
  });

  it("getNotes maps + returns notes newest-first", async () => {
    const stub = makeStubPb();
    // The stub's getFullList ignores the (log, subject) filter and returns
    // every row, so seed only matching rows here. Subject/log scoping is the
    // server filter's job and is independently exercised by the
    // subscribeToLog log-scoping test (the `inLog` predicate). What this test
    // pins is the mapper + the newest-first ordering getNotes applies.
    seedNote(stub, "n1", "L1", "activity", "A1", "2024-01-01T00:00:00Z", [textEntry("oldest")]);
    seedNote(stub, "n2", "L1", "activity", "A1", "2024-03-01T00:00:00Z", [textEntry("newest")]);
    seedNote(stub, "n3", "L1", "activity", "A1", "2024-02-01T00:00:00Z", [textEntry("middle")]);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const travel = new PocketBaseTravelBackend(() => stub.pb, wpb, mirror);

    const notes = await travel.getNotes("L1", "activity", "A1");
    expect(notes.map((n) => n.id)).toEqual(["n2", "n3", "n1"]);
    expect(notes[0].entries).toEqual([textEntry("newest")]);
    expect(notes[0].subjectType).toBe("activity");
    expect(notes[0].subjectId).toBe("A1");
    expect(notes[0].createdBy).toBe("u1");
  });

  it("updateNote replaces the entries array wholesale", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const travel = new PocketBaseTravelBackend(() => stub.pb, wpb, mirror);

    const id = await travel.addNote("L1", "trip", "T1", "u1", [textEntry("v1")]);
    await drain();

    await travel.updateNote(id, [textEntry("v2"), { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }]);
    await drain();

    const row = stub.col("travel_notes").records.get(id) as unknown as Record<string, unknown>;
    expect(row.entries).toEqual([
      textEntry("v2"),
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });

  it("deleteNote removes the row", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const travel = new PocketBaseTravelBackend(() => stub.pb, wpb, mirror);

    const id = await travel.addNote("L1", "day", "T1:2024-05-01", "u1", [textEntry("rainy day")]);
    await drain();
    expect(stub.col("travel_notes").records.get(id)).toBeDefined();

    await travel.deleteNote(id);
    await drain();
    expect(stub.col("travel_notes").records.get(id)).toBeUndefined();
  });

  it("subscribeToLog surfaces travel_notes through onNotes, newest-first", async () => {
    const stub = makeStubPb();
    // Seed two notes for the log so the initial getList serves them.
    seedNote(stub, "n1", "L1", "activity", "A1", "2024-01-01T00:00:00Z", [textEntry("old")]);
    seedNote(stub, "n2", "L1", "day", "T1:2024-05-01", "2024-06-01T00:00:00Z", [textEntry("new")]);
    // A note in a different log must NOT leak in.
    seedNote(stub, "other", "L2", "activity", "A9", "2024-07-01T00:00:00Z", [textEntry("foreign")]);

    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const travel = new PocketBaseTravelBackend(() => stub.pb, wpb, mirror);

    const seen: string[][] = [];
    const unsub = travel.subscribeToLog("L1", {
      onLog: () => {},
      onTrips: () => {},
      onActivities: () => {},
      onItineraries: () => {},
      onDayEntries: () => {},
      onNotes: (notes) => seen.push(notes.map((n) => n.id)),
    });

    await drain();

    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    // Newest-first, scoped to L1 only.
    expect(last).toEqual(["n2", "n1"]);
    unsub();
  });
});
