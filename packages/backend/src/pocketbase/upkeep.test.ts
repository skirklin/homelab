/**
 * PocketBaseUpkeepBackend — clearDoneTasks unit tests.
 *
 * Exercises the wpb-cache fast path: seed records via wpb.create (which
 * pushes into the queue and is immediately visible via viewCollection),
 * then call clearDoneTasks and assert that only completed one_shot rows
 * got cleared = true. Recurring tasks and not-yet-completed one_shots
 * must be left untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type PocketBase from "pocketbase";
import type { RecordModel, UnsubscribeFunc } from "pocketbase";
import { wrapPocketBase } from "../wrapped-pb";
import { createMirror } from "../wrapped-pb/mirror";
import { clearAllMutations } from "../wrapped-pb/persistence";
import { PocketBaseUpkeepBackend, taskFromRecord } from "./upkeep";
import type { RawRecord } from "../wrapped-pb/mirror";

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
          const id = (body.id as string) ?? `${name}-${c.records.size}`;
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

beforeEach(async () => {
  await clearAllMutations();
});

/**
 * Seed a task into the wpb cache by routing the create through wpb. Doing
 * it this way (rather than poking the stub's records map directly) puts
 * the record into wpb's MutationQueue so `viewCollection` can see it,
 * which is what `clearDoneTasks` reads from on the fast path.
 */
async function seedTask(
  wpb: ReturnType<typeof wrapPocketBase>,
  fields: {
    id: string;
    list: string;
    task_type: "recurring" | "one_shot";
    completed?: boolean;
    cleared?: boolean;
  },
): Promise<void> {
  await wpb.collection("tasks").create({
    id: fields.id,
    list: fields.list,
    parent_id: "",
    path: fields.id,
    position: 0,
    name: fields.id,
    description: "",
    task_type: fields.task_type,
    frequency: 0,
    last_completed: null,
    completed: !!fields.completed,
    snoozed_until: null,
    assignees: [],
    tags: [],
    collapsed: false,
    cleared: !!fields.cleared,
  });
}

describe("PocketBaseUpkeepBackend.clearDoneTasks", () => {
  it("only clears completed one_shot tasks; recurring + incomplete + already-cleared are untouched", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const upkeep = new PocketBaseUpkeepBackend(() => stub.pb, wpb, mirror);

    // The list under test
    const listId = "L1";

    // ─── seed: a mix of tasks the predicate should and should not pick up
    await seedTask(wpb, { id: "done-1",    list: listId, task_type: "one_shot",  completed: true  });
    await seedTask(wpb, { id: "done-2",    list: listId, task_type: "one_shot",  completed: true  });
    await seedTask(wpb, { id: "open-1",    list: listId, task_type: "one_shot",  completed: false }); // not completed
    await seedTask(wpb, { id: "recur-1",   list: listId, task_type: "recurring", completed: true  }); // recurring (must skip even if completed=true)
    await seedTask(wpb, { id: "recur-2",   list: listId, task_type: "recurring", completed: false });
    await seedTask(wpb, { id: "already-1", list: listId, task_type: "one_shot",  completed: true, cleared: true }); // already cleared

    // A completed one_shot in ANOTHER list — must not be touched, prevents
    // cross-list bleed via the predicate.
    await seedTask(wpb, { id: "other-done", list: "L2", task_type: "one_shot", completed: true });

    // Drain microtasks so wpb's create pipeline lands.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    const result = await upkeep.clearDoneTasks(listId);
    expect(result.clearedCount).toBe(2);

    // Drain optimistic update writes.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    // Inspect what landed in the stub PB. Only done-1 / done-2 should have
    // flipped to cleared = true; every other row keeps its prior cleared
    // value.
    const tasks = stub.col("tasks");
    expect(tasks.records.get("done-1")?.cleared).toBe(true);
    expect(tasks.records.get("done-2")?.cleared).toBe(true);

    expect(tasks.records.get("open-1")?.cleared).toBe(false);
    expect(tasks.records.get("recur-1")?.cleared).toBe(false);
    expect(tasks.records.get("recur-2")?.cleared).toBe(false);
    expect(tasks.records.get("already-1")?.cleared).toBe(true);
    expect(tasks.records.get("other-done")?.cleared).toBe(false);
  });

  it("is a no-op (clearedCount=0) when there are no clearable tasks", async () => {
    const stub = makeStubPb();
    const wpb = wrapPocketBase(() => stub.pb);
    const mirror = createMirror(() => stub.pb, wpb);
    const upkeep = new PocketBaseUpkeepBackend(() => stub.pb, wpb, mirror);

    await seedTask(wpb, { id: "open-1",  list: "L1", task_type: "one_shot",  completed: false });
    await seedTask(wpb, { id: "recur-1", list: "L1", task_type: "recurring", completed: false });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    const result = await upkeep.clearDoneTasks("L1");
    expect(result.clearedCount).toBe(0);

    // Verify nothing got flipped.
    const tasks = stub.col("tasks");
    expect(tasks.records.get("open-1")?.cleared).toBe(false);
    expect(tasks.records.get("recur-1")?.cleared).toBe(false);
  });
});

/**
 * taskFromRecord — THE flat-columns → discriminated-union choke point.
 * Construct raw records the way the mapper reads them (snake_case PB columns)
 * and assert the resulting Task variant.
 */
describe("taskFromRecord", () => {
  const baseCols = (overrides: Record<string, unknown>): RawRecord => ({
    id: "t1",
    list: "L1",
    parent_id: "",
    path: "t1",
    position: 0,
    name: "Task",
    description: "",
    snoozed_until: null,
    assignees: [],
    created_by: "u1",
    tags: [],
    collapsed: false,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("one_shot with a present deadline → schedule {kind:'dated', deadline, leadDays}", () => {
    const task = taskFromRecord(baseCols({
      task_type: "one_shot",
      deadline: "2026-03-15T00:00:00Z",
      deadline_lead_days: 3,
      completed: false,
      cleared: false,
    }));
    expect(task.taskType).toBe("one_shot");
    if (task.taskType !== "one_shot") throw new Error("expected one_shot");
    expect(task.schedule.kind).toBe("dated");
    if (task.schedule.kind !== "dated") throw new Error("expected dated");
    expect(task.schedule.deadline).toEqual(new Date("2026-03-15T00:00:00Z"));
    expect(task.schedule.leadDays).toBe(3);
  });

  it("one_shot with null deadline → schedule {kind:'someday'}", () => {
    const task = taskFromRecord(baseCols({
      task_type: "one_shot",
      deadline: null,
      deadline_lead_days: null,
      completed: false,
      cleared: false,
    }));
    if (task.taskType !== "one_shot") throw new Error("expected one_shot");
    expect(task.schedule).toEqual({ kind: "someday" });
  });

  it("one_shot with empty-string deadline (falsy) → schedule {kind:'someday'}", () => {
    const task = taskFromRecord(baseCols({
      task_type: "one_shot",
      deadline: "",
      deadline_lead_days: 0,
      completed: false,
      cleared: false,
    }));
    if (task.taskType !== "one_shot") throw new Error("expected one_shot");
    expect(task.schedule).toEqual({ kind: "someday" });
  });

  it("recurring → frequency + lastCompleted populated, no schedule field", () => {
    const task = taskFromRecord(baseCols({
      task_type: "recurring",
      frequency: { value: 7, unit: "days" },
      last_completed: "2026-02-01T00:00:00Z",
    }));
    expect(task.taskType).toBe("recurring");
    if (task.taskType !== "recurring") throw new Error("expected recurring");
    expect(task.frequency).toEqual({ value: 7, unit: "days" });
    expect(task.lastCompleted).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect("schedule" in task).toBe(false);
  });

  // A recurring record can carry a bare `0` (create path defaults frequency to
  // 0) or a missing/malformed value. The mapper must coerce it to a valid
  // Frequency object so no reader (e.g. formatFrequency) crashes on `0.unit`.
  it("recurring with frequency: 0 → coerced to a valid default Frequency", () => {
    const task = taskFromRecord(baseCols({ task_type: "recurring", frequency: 0 }));
    if (task.taskType !== "recurring") throw new Error("expected recurring");
    expect(task.frequency).toEqual({ value: 1, unit: "days" });
  });

  it("recurring with missing frequency → coerced to a valid default Frequency", () => {
    const task = taskFromRecord(baseCols({ task_type: "recurring" }));
    if (task.taskType !== "recurring") throw new Error("expected recurring");
    expect(task.frequency).toEqual({ value: 1, unit: "days" });
  });

  it("recurring with malformed frequency (bad unit) → coerced to default", () => {
    const task = taskFromRecord(
      baseCols({ task_type: "recurring", frequency: { value: 3, unit: "years" } }),
    );
    if (task.taskType !== "recurring") throw new Error("expected recurring");
    expect(task.frequency).toEqual({ value: 1, unit: "days" });
  });
});
