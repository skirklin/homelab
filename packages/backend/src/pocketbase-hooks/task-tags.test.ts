/**
 * Hook-execution test for POST /api/tasks/:id/tags in
 * infra/pocketbase/pb_hooks/task_tags.pb.js.
 *
 * The route closes the cross-device race in tagTask by running the
 * read-merge-write inside a single SQL transaction. We can't exercise
 * the SQL serialization itself from a Node vm, but we CAN exercise the
 * handler's semantics:
 *   - add succeeds, remove succeeds, both in one call
 *   - dedupe (no duplicate tags)
 *   - byte-array unwrap (the goja []byte footgun from sharing.pb.js)
 *   - auth rejection (no auth → 401)
 *   - 403 for non-owners
 *   - 404 for missing task / list
 *   - runInTransaction is invoked (correctness of the SQL boundary is
 *     enforced by SQLite itself when this ships to PB)
 *
 * Same vm-sandbox strategy as sharing-redeem.test.ts: load the real hook
 * source, register a fake `routerAdd` that captures the handler, then
 * invoke it with a synthetic `e`. Stubs mimic the goja $app surface
 * including `runInTransaction(cb)` (we just call cb(txApp) synchronously
 * with the same stub — the SQL guarantees are out of scope for the test).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const hookPath = path.join(repoRoot, "infra/pocketbase/pb_hooks/task_tags.pb.js");

type Handler = (e: unknown) => unknown;

interface StubRecord {
  id: string;
  _fields: Record<string, unknown>;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
}

function makeRecord(id: string, fields: Record<string, unknown>): StubRecord {
  const storage = { ...fields };
  return {
    id,
    _fields: storage,
    get(name: string) {
      return storage[name];
    },
    set(name: string, value: unknown) {
      storage[name] = value;
    },
  };
}

function asByteArray(value: unknown): number[] {
  const json = JSON.stringify(value);
  const out: number[] = [];
  for (let i = 0; i < json.length; i++) out.push(json.charCodeAt(i));
  return out;
}

interface LoadedHook {
  handler: Handler;
  records: Map<string, StubRecord>;
  saved: StubRecord[];
  txnCalls: number;
}

function loadHook(): LoadedHook {
  const records = new Map<string, StubRecord>();
  const saved: StubRecord[] = [];
  const state = { txnCalls: 0 };
  let captured: Handler | null = null;

  const $app = {
    findRecordById: (collection: string, id: string) => {
      const r = records.get(id);
      if (!r || r._fields.__collection !== collection) {
        throw new Error(`not found: ${collection}/${id}`);
      }
      return r;
    },
    save: (r: StubRecord) => {
      saved.push(r);
    },
    runInTransaction: (cb: (txApp: unknown) => void) => {
      state.txnCalls++;
      // Within the test the same $app stub is the "txApp" — we're not
      // exercising SQL isolation here, just the JS-side semantics.
      cb($app);
    },
  };

  const sandbox = {
    routerAdd: (method: string, route: string, handler: Handler) => {
      if (method === "POST" && route === "/api/tasks/{id}/tags") {
        captured = handler;
      }
    },
    onRecordCreateRequest: () => {},
    onRecordUpdateRequest: () => {},
    $app,
    BadRequestError: class BadRequestError extends Error {},
    ForbiddenError: class ForbiddenError extends Error {},
    console: { log: () => {} },
  };

  const code = readFileSync(hookPath, "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "task_tags.pb.js" });

  if (!captured) throw new Error("POST /api/tasks/{id}/tags handler was not registered");
  return { handler: captured, records, saved, txnCalls: 0 } as LoadedHook & {
    // We hand the test the live state object below so it can read txnCalls
    // after invocation. Hack the cast.
  };
}

interface FixtureOptions {
  initialTags: unknown;
  authUserId?: string;
  ownerIds?: string[];
}

function setupFixture(hook: LoadedHook, opts: FixtureOptions): {
  task: StubRecord;
  list: StubRecord;
} {
  hook.records.clear();
  hook.saved.length = 0;
  const list = makeRecord("LIST0000000001", {
    __collection: "task_lists",
    owners: opts.ownerIds ?? ["USER0000000001"],
  });
  const task = makeRecord("TASK0000000001", {
    __collection: "tasks",
    list: list.id,
    tags: opts.initialTags,
  });
  hook.records.set(list.id, list);
  hook.records.set(task.id, task);
  return { task, list };
}

function makeEvent(authUserId: string | null, taskId: string, body: unknown) {
  const responses: Array<{ status: number; body: unknown }> = [];
  const e = {
    auth: authUserId ? { id: authUserId } : null,
    request: {
      pathValue: (name: string) => (name === "id" ? taskId : ""),
    },
    requestInfo: () => ({ body }),
    json: (status: number, b: unknown) => {
      responses.push({ status, body: b });
      return { status, body: b };
    },
  };
  return { e, responses };
}

describe("task_tags.pb.js POST /api/tasks/:id/tags", () => {
  let hook: LoadedHook;

  beforeAll(() => {
    hook = loadHook();
  });

  it("adds new tags (current = ['a'], add ['b','c'] → ['a','b','c'])", () => {
    const { task } = setupFixture(hook, { initialTags: ["a"] });
    const { e, responses } = makeEvent("USER0000000001", task.id, {
      add: ["b", "c"],
    });
    hook.handler(e);
    expect(responses[0].status).toBe(200);
    expect((responses[0].body as { task: { tags: string[] } }).task.tags).toEqual(["a", "b", "c"]);
    expect(task._fields.tags).toEqual(["a", "b", "c"]);
  });

  it("removes tags (current = ['a','b','c'], remove ['b'] → ['a','c'])", () => {
    const { task } = setupFixture(hook, { initialTags: ["a", "b", "c"] });
    const { e, responses } = makeEvent("USER0000000001", task.id, {
      remove: ["b"],
    });
    hook.handler(e);
    expect(responses[0].status).toBe(200);
    expect(task._fields.tags).toEqual(["a", "c"]);
  });

  it("applies remove before add in a single call (current ['x','y'], add ['z'], remove ['x'] → ['y','z'])", () => {
    const { task } = setupFixture(hook, { initialTags: ["x", "y"] });
    const { e } = makeEvent("USER0000000001", task.id, {
      add: ["z"],
      remove: ["x"],
    });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["y", "z"]);
  });

  it("dedupes when add already exists (current ['a'], add ['a','b'] → ['a','b'])", () => {
    const { task } = setupFixture(hook, { initialTags: ["a"] });
    const { e } = makeEvent("USER0000000001", task.id, { add: ["a", "b"] });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["a", "b"]);
  });

  it("dedupes within the add list itself (current [], add ['a','a','b'] → ['a','b'])", () => {
    const { task } = setupFixture(hook, { initialTags: [] });
    const { e } = makeEvent("USER0000000001", task.id, { add: ["a", "a", "b"] });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["a", "b"]);
  });

  it("re-tag in one call: current ['x'], remove ['x'], add ['x'] → ['x'] (toggle-safe)", () => {
    const { task } = setupFixture(hook, { initialTags: ["x"] });
    const { e } = makeEvent("USER0000000001", task.id, {
      add: ["x"],
      remove: ["x"],
    });
    hook.handler(e);
    // remove ['x'] strips it, then add ['x'] re-adds — final state is ['x'].
    expect(task._fields.tags).toEqual(["x"]);
  });

  it("unwraps the byte-array goja shape for tags", () => {
    // tags persisted as JSON bytes — the same shape that corrupted
    // recipe_boxes on 2026-05-26. With the inlined toJsArray helper the
    // merge must produce a clean string array, not bytes-plus-appended.
    const original = ["travel:abc", "activity:xyz"];
    const { task } = setupFixture(hook, { initialTags: asByteArray(original) });
    const { e } = makeEvent("USER0000000001", task.id, { add: ["new-tag"] });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["travel:abc", "activity:xyz", "new-tag"]);
    // And serializes cleanly.
    expect(JSON.stringify(task._fields.tags)).toBe(
      '["travel:abc","activity:xyz","new-tag"]',
    );
  });

  it("unwraps the JSON-string goja shape for tags", () => {
    const { task } = setupFixture(hook, { initialTags: JSON.stringify(["a", "b"]) });
    const { e } = makeEvent("USER0000000001", task.id, { add: ["c"] });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["a", "b", "c"]);
  });

  it("treats null tags as an empty array (never-set column)", () => {
    const { task } = setupFixture(hook, { initialTags: null });
    const { e } = makeEvent("USER0000000001", task.id, { add: ["first"] });
    hook.handler(e);
    expect(task._fields.tags).toEqual(["first"]);
  });

  it("rejects unauthenticated callers with 401", () => {
    const { task } = setupFixture(hook, { initialTags: [] });
    const { e, responses } = makeEvent(null, task.id, { add: ["x"] });
    hook.handler(e);
    expect(responses[0].status).toBe(401);
    // No save happened.
    expect(hook.saved.length).toBe(0);
  });

  it("rejects callers who are not in list.owners with 403", () => {
    const { task } = setupFixture(hook, {
      initialTags: ["a"],
      ownerIds: ["SOMEONE_ELSE001"],
    });
    const { e, responses } = makeEvent("USER0000000001", task.id, { add: ["x"] });
    hook.handler(e);
    expect(responses[0].status).toBe(403);
    // Task untouched.
    expect(task._fields.tags).toEqual(["a"]);
    expect(hook.saved.length).toBe(0);
  });

  it("rejects empty body (no add[] and no remove[]) with 400", () => {
    const { task } = setupFixture(hook, { initialTags: ["a"] });
    const { e, responses } = makeEvent("USER0000000001", task.id, {});
    hook.handler(e);
    expect(responses[0].status).toBe(400);
    expect(hook.saved.length).toBe(0);
  });

  it("returns 404 when the task does not exist", () => {
    setupFixture(hook, { initialTags: [] });
    const { e, responses } = makeEvent("USER0000000001", "DOES_NOT_EXIST", {
      add: ["x"],
    });
    hook.handler(e);
    expect(responses[0].status).toBe(404);
  });

  it("returns 404 when the task's list cannot be resolved", () => {
    hook.records.clear();
    hook.saved.length = 0;
    // Task with a list id that doesn't exist anywhere — synthetic
    // referential-integrity gap; the route should fail fast rather
    // than 500 inside the transaction.
    const orphan = makeRecord("ORPHAN00000001", {
      __collection: "tasks",
      list: "MISSING00000001",
      tags: [],
    });
    hook.records.set(orphan.id, orphan);
    const { e, responses } = makeEvent("USER0000000001", orphan.id, {
      add: ["x"],
    });
    hook.handler(e);
    expect(responses[0].status).toBe(404);
  });

  it("ignores non-array add / remove fields without crashing", () => {
    const { task } = setupFixture(hook, { initialTags: ["keep"] });
    const { e, responses } = makeEvent("USER0000000001", task.id, {
      add: "not-an-array",
      remove: { also: "not-an-array" },
    });
    hook.handler(e);
    // Defaulting to [] for both → 400 "at least one of add/remove required".
    expect(responses[0].status).toBe(400);
    expect(task._fields.tags).toEqual(["keep"]);
  });

  it("invokes runInTransaction (atomic read-merge-write boundary)", () => {
    // The actual SQL serialization is provided by SQLite when this ships;
    // the JS-side guarantee we can assert is that the handler routes the
    // mutation through runInTransaction at all.
    let calls = 0;
    const records = new Map<string, StubRecord>();
    const saved: StubRecord[] = [];
    let captured: Handler | null = null;
    const $app = {
      findRecordById: (collection: string, id: string) => {
        const r = records.get(id);
        if (!r || r._fields.__collection !== collection) throw new Error("nf");
        return r;
      },
      save: (r: StubRecord) => { saved.push(r); },
      runInTransaction: (cb: (tx: unknown) => void) => {
        calls++;
        cb($app);
      },
    };
    const sandbox = {
      routerAdd: (m: string, r: string, h: Handler) => {
        if (m === "POST" && r === "/api/tasks/{id}/tags") captured = h;
      },
      onRecordCreateRequest: () => {},
      onRecordUpdateRequest: () => {},
      $app,
      BadRequestError: class extends Error {},
      ForbiddenError: class extends Error {},
      console: { log: () => {} },
    };
    const code = readFileSync(hookPath, "utf8");
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "task_tags.pb.js" });
    if (!captured) throw new Error("handler not registered");

    const list = makeRecord("L1", { __collection: "task_lists", owners: ["U1"] });
    const task = makeRecord("T1", { __collection: "tasks", list: "L1", tags: ["a"] });
    records.set(list.id, list);
    records.set(task.id, task);

    const { e } = makeEvent("U1", "T1", { add: ["b"] });
    (captured as Handler)(e);
    expect(calls).toBe(1);
    expect(task._fields.tags).toEqual(["a", "b"]);
  });

  it("bypasses the per-list ownership check for superuser callers (admin-pb path)", () => {
    // The Hono API service in services/api proxies hlk_/mcpat_ token writes
    // through admin-pb, then pb.send()'s the new transactional hook to
    // close the same cross-device race on that path. The hook recognizes
    // superuser auth (collection().name === "_superusers") and skips the
    // owners check — the route-side userOwnsTaskList() has already gated
    // the call.
    const { task } = setupFixture(hook, {
      initialTags: ["a"],
      ownerIds: ["SOMEONE_ELSE001"], // caller is NOT in owners
    });
    const superuserAuth = {
      id: "SUPERUSER000001",
      collection: () => ({ name: "_superusers" }),
    };
    const { e, responses } = makeEvent("SUPERUSER000001", task.id, { add: ["x"] });
    e.auth = superuserAuth;
    hook.handler(e);
    expect(responses[0].status).toBe(200);
    expect(task._fields.tags).toEqual(["a", "x"]);
  });
});
