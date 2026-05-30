/**
 * Hook-execution test for the POST /api/sharing/redeem handler in
 * infra/pocketbase/pb_hooks/sharing.pb.js, specifically the travel_log
 * branch where `user.get("travel_slugs")` may surface as a goja []byte.
 *
 * Strategy: load the actual sharing.pb.js source in a Node `vm` context
 * with a stubbed goja-style global surface (routerAdd, $app, BadRequestError,
 * ForbiddenError, console). Capture the registered POST handler, then
 * invoke it with a synthetic `e` carrying:
 *   - auth + body { code }
 *   - a fake user whose `travel_slugs` field returns a byte-array form
 *
 * Assertion: after redemption, the user's travel_slugs map contains the
 * new slug → log-id mapping. With the old `user.get("travel_slugs") || {}`
 * code, the for-in loop over a goja byte-array silently no-oped and the
 * slug never got written. With the defensive unwrap, it works.
 *
 * This isn't a real goja test (we're in Node/V8) but it exercises the
 * exact JS that ships, including the inlined unwrapPbJsonObject helper.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const sharingHookPath = path.join(repoRoot, "infra/pocketbase/pb_hooks/sharing.pb.js");

type Handler = (e: unknown) => unknown;

interface StubRecord {
  id: string;
  // Internal storage; .get/.set go through it.
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

interface LoadedHooks {
  postRedeem: Handler;
  records: Map<string, StubRecord>;
  saved: StubRecord[];
  /**
   * Every call the hook makes to findFirstRecordByFilter lands here so each
   * test can assert the exact filter shape it expected. The previous stub
   * did `void filter` and matched purely on params — so when the hook's
   * filter dropped `redeemed = false`, no test failed. With this record we
   * pin the contract: any drift in the filter string fails the test.
   */
  filterCalls: Array<{ collection: string; filter: string; params: Record<string, unknown> }>;
}

/**
 * Load sharing.pb.js into a fresh vm sandbox with stubs that mimic the
 * goja API surface. Returns the captured POST handler + a records map the
 * test can prepopulate.
 */
function loadSharingHook(): LoadedHooks {
  const records = new Map<string, StubRecord>();
  const saved: StubRecord[] = [];
  const filterCalls: LoadedHooks["filterCalls"] = [];
  let postRedeem: Handler | null = null;

  const $app = {
    findFirstRecordByFilter: (collection: string, filter: string, params: Record<string, unknown>) => {
      // Record the call so tests can assert the exact filter the hook
      // emitted. We still match the record by params.code (the only field
      // the hook narrows on today), but if the hook ever adds e.g.
      // `redeemed = false` back, the recorded filter string is the
      // load-bearing contract the tests pin against.
      filterCalls.push({ collection, filter, params: { ...params } });
      const code = String(params.code);
      for (const r of records.values()) {
        if (r._fields.__collection === collection && r._fields.code === code) {
          return r;
        }
      }
      throw new Error("not found");
    },
    findRecordById: (collection: string, id: string) => {
      const r = records.get(id);
      if (!r || r._fields.__collection !== collection) throw new Error(`not found: ${collection}/${id}`);
      return r;
    },
    save: (r: StubRecord) => {
      saved.push(r);
    },
  };

  const sandbox = {
    routerAdd: (method: string, route: string, handler: Handler) => {
      if (method === "POST" && route === "/api/sharing/redeem") {
        postRedeem = handler;
      }
    },
    // We don't exercise the create-invite branch in this test; capture and ignore.
    onRecordCreateRequest: (_handler: Handler, _collection: string) => {
      void _handler;
      void _collection;
    },
    $app,
    BadRequestError: class BadRequestError extends Error {},
    ForbiddenError: class ForbiddenError extends Error {},
    console: { log: () => {} },
    // Node intrinsics the hook code touches: Array, JSON, Date, String, Object.
    // vm gives us these by default via the context's global scope.
  };

  const code = readFileSync(sharingHookPath, "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "sharing.pb.js" });

  if (!postRedeem) throw new Error("POST /api/sharing/redeem handler was not registered");
  return { postRedeem, records, saved, filterCalls };
}

/**
 * Pin the exact filter shape the hook should emit when looking up an invite
 * by code. If sharing.pb.js ever changes the filter (e.g. re-adds
 * `redeemed = false`, or switches placeholder syntax), every test calling
 * this fails loud — that's the regression-catcher the original `void filter`
 * stub had no way to surface.
 */
const EXPECTED_INVITE_FILTER = "code = {:code}";

describe("sharing.pb.js POST /api/sharing/redeem — travel_slugs goja []byte defense", () => {
  let hooks: LoadedHooks;

  beforeAll(() => {
    hooks = loadSharingHook();
  });

  function setupInviteAndUser(travelSlugsValue: unknown): {
    user: StubRecord;
    invite: StubRecord;
    travelLog: StubRecord;
  } {
    hooks.records.clear();
    hooks.saved.length = 0;
    hooks.filterCalls.length = 0;

    const user = makeRecord("USER0000000001", {
      __collection: "users",
      travel_slugs: travelSlugsValue,
    });
    const travelLog = makeRecord("TRAVELLOG00001", {
      __collection: "travel_logs",
      name: "Family Trips",
      owners: ["OWNER000000001"],
    });
    const invite = makeRecord("INVITE00000001", {
      __collection: "sharing_invites",
      code: "ABCDEF12",
      redeemed: false,
      target_type: "travel_log",
      target_id: travelLog.id,
      expires_at: "",
    });
    hooks.records.set(user.id, user);
    hooks.records.set(travelLog.id, travelLog);
    hooks.records.set(invite.id, invite);
    return { user, invite, travelLog };
  }

  function makeEvent(authUserId: string, code: string) {
    const responses: Array<{ status: number; body: unknown }> = [];
    const e = {
      auth: { id: authUserId },
      requestInfo: () => ({ body: { code } }),
      json: (status: number, body: unknown) => {
        responses.push({ status, body });
        return { status, body };
      },
    };
    return { e, responses };
  }

  it("writes a new slug when travel_slugs is the goja byte-array form", () => {
    // Pre-existing slugs `{ "old": "PREVLOG0000001" }` stored as a byte-array
    // (what goja actually hands back for JSON columns).
    const existing = { old: "PREVLOG0000001" };
    const { user, invite, travelLog } = setupInviteAndUser(asByteArray(existing));

    const { e } = makeEvent(user.id, "ABCDEF12");
    hooks.postRedeem(e);

    // The user.travel_slugs should now include `family-trips → TRAVELLOG00001`
    // alongside the preserved `old` entry. This is the regression the
    // defensive unwrap exists to prevent — without it, the for-in scan over
    // the byte-array silently no-oped and the slug never landed.
    const final = user._fields.travel_slugs as Record<string, string>;
    expect(final).toBeTypeOf("object");
    expect(final["old"]).toBe("PREVLOG0000001");
    expect(final["family-trips"]).toBe(travelLog.id);

    // Invite should be marked redeemed.
    expect(invite._fields.redeemed).toBe(true);
    expect(invite._fields.redeemed_by).toBe(user.id);

    // Pin the filter contract — see EXPECTED_INVITE_FILTER docstring above.
    expect(hooks.filterCalls).toHaveLength(1);
    expect(hooks.filterCalls[0].collection).toBe("sharing_invites");
    expect(hooks.filterCalls[0].filter).toBe(EXPECTED_INVITE_FILTER);
    expect(hooks.filterCalls[0].params).toEqual({ code: "ABCDEF12" });
  });

  it("works when travel_slugs is already a plain object (other goja path)", () => {
    const { user, invite, travelLog } = setupInviteAndUser({ old: "PREVLOG0000001" });
    const { e } = makeEvent(user.id, "ABCDEF12");
    hooks.postRedeem(e);

    const final = user._fields.travel_slugs as Record<string, string>;
    expect(final["old"]).toBe("PREVLOG0000001");
    expect(final["family-trips"]).toBe(travelLog.id);
    expect(invite._fields.redeemed).toBe(true);
  });

  it("works when travel_slugs is null (never-set)", () => {
    const { user, invite, travelLog } = setupInviteAndUser(null);
    const { e } = makeEvent(user.id, "ABCDEF12");
    hooks.postRedeem(e);

    const final = user._fields.travel_slugs as Record<string, string>;
    expect(final["family-trips"]).toBe(travelLog.id);
    expect(invite._fields.redeemed).toBe(true);
  });

  it("works when travel_slugs is a JSON string (third goja shape)", () => {
    const { user, invite, travelLog } = setupInviteAndUser(JSON.stringify({ old: "PREVLOG0000001" }));
    const { e } = makeEvent(user.id, "ABCDEF12");
    hooks.postRedeem(e);

    const final = user._fields.travel_slugs as Record<string, string>;
    expect(final["old"]).toBe("PREVLOG0000001");
    expect(final["family-trips"]).toBe(travelLog.id);
    expect(invite._fields.redeemed).toBe(true);
  });

  it("returns idempotent success when the same user retries an already-redeemed invite", () => {
    // Race scenario: client fires POST #1 → effect cleanup aborts the fetch
    // → server completes the redeem anyway → effect re-runs and POST #2 hits
    // the already-redeemed invite. The user IS already in the target's
    // owners (POST #1 put them there); the hook must surface success so the
    // client redirects to the box instead of rendering "could not redeem".
    hooks.records.clear();
    hooks.saved.length = 0;
    hooks.filterCalls.length = 0;

    const userId = "USER0000000001";
    const box = makeRecord("BOX00000000001", {
      __collection: "recipe_boxes",
      name: "Already Joined",
      owners: [userId, "ORIGINALOWNER0"],
    });
    const invite = makeRecord("INVITE00000003", {
      __collection: "sharing_invites",
      code: "RETRY123",
      redeemed: true,
      redeemed_by: userId,
      target_type: "box",
      target_id: box.id,
      expires_at: "",
    });
    hooks.records.set(box.id, box);
    hooks.records.set(invite.id, invite);

    const { e, responses } = makeEvent(userId, "RETRY123");
    hooks.postRedeem(e);

    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe(200);
    expect(responses[0].body).toEqual({
      success: true,
      target_type: "box",
      target_id: box.id,
    });
    // No writes — this is purely an idempotent confirmation.
    expect(hooks.saved.length).toBe(0);
  });

  it("rejects a different user trying to redeem an already-redeemed invite", () => {
    // The "single-use" guarantee still holds for OTHER users. The Playwright
    // already-redeemed test asserts this 4xx path.
    hooks.records.clear();
    hooks.saved.length = 0;
    hooks.filterCalls.length = 0;

    const firstUserId = "FIRSTUSER00001";
    const secondUserId = "SECONDUSER0001";
    const box = makeRecord("BOX00000000002", {
      __collection: "recipe_boxes",
      name: "Single Use",
      owners: [firstUserId],
    });
    const invite = makeRecord("INVITE00000004", {
      __collection: "sharing_invites",
      code: "ONCEONLY",
      redeemed: true,
      redeemed_by: firstUserId,
      target_type: "box",
      target_id: box.id,
      expires_at: "",
    });
    hooks.records.set(box.id, box);
    hooks.records.set(invite.id, invite);

    const { e, responses } = makeEvent(secondUserId, "ONCEONLY");
    hooks.postRedeem(e);

    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe(404);
    // Same generic error message as before — clients key off the status.
    expect(hooks.saved.length).toBe(0);
  });

  it("does not double-map an already-redeemed target (hook short-circuits)", () => {
    // travel_slugs already points at the target id; the hook MUST detect this
    // (which requires unwrapping the byte-array so for-in actually iterates)
    // and skip both the set and the save. We verify via the saved log:
    // only the invite + travel_log get saved, not the user.
    const initial = asByteArray({ existing: "TRAVELLOG00001" });
    const { user, invite, travelLog } = setupInviteAndUser(initial);
    const { e } = makeEvent(user.id, "ABCDEF12");
    hooks.postRedeem(e);

    // user.set("travel_slugs", ...) was NOT called → stored value is still
    // the original byte-array shape we wrote.
    expect(user._fields.travel_slugs).toBe(initial);

    // saved should contain travel_log (owners update) + invite (redeemed),
    // but NOT user (no slugs write).
    const savedIds = hooks.saved.map((r) => r.id);
    expect(savedIds).toContain(invite.id);
    expect(savedIds).toContain(travelLog.id);
    expect(savedIds).not.toContain(user.id);
  });
});

describe("sharing.pb.js POST /api/sharing/redeem — filter-string regression catcher", () => {
  // Demonstration: load a doctored copy of sharing.pb.js where the invite
  // lookup filter is back to the pre-866551e form (`code && redeemed = false`).
  // The strict-equality assertion against EXPECTED_INVITE_FILTER must reject
  // it — that's the proof the new stub catches the regression the original
  // `void filter` stub could not.
  it("would FAIL if the hook re-introduced `redeemed = false` to the filter", () => {
    const records = new Map<string, StubRecord>();
    const saved: StubRecord[] = [];
    const filterCalls: Array<{ collection: string; filter: string; params: Record<string, unknown> }> = [];
    let postRedeem: Handler | null = null;

    const $app = {
      findFirstRecordByFilter: (collection: string, filter: string, params: Record<string, unknown>) => {
        filterCalls.push({ collection, filter, params: { ...params } });
        const code = String(params.code);
        for (const r of records.values()) {
          if (r._fields.__collection === collection && r._fields.code === code) {
            return r;
          }
        }
        throw new Error("not found");
      },
      findRecordById: (collection: string, id: string) => {
        const r = records.get(id);
        if (!r || r._fields.__collection !== collection) throw new Error(`not found: ${collection}/${id}`);
        return r;
      },
      save: (r: StubRecord) => {
        saved.push(r);
      },
    };

    const sandbox = {
      routerAdd: (method: string, route: string, handler: Handler) => {
        if (method === "POST" && route === "/api/sharing/redeem") postRedeem = handler;
      },
      onRecordCreateRequest: () => {},
      $app,
      BadRequestError: class BadRequestError extends Error {},
      ForbiddenError: class ForbiddenError extends Error {},
      console: { log: () => {} },
    };

    // Doctor the hook source: swap the current filter for a different one.
    // If the test asserted only on side effects, this swap would slip past;
    // with the new filter-string assertion it must be caught.
    const original = readFileSync(sharingHookPath, "utf8");
    const REGRESSED_FILTER = "code = {:code} && redeemed = false";
    const doctored = original.replace(`code = {:code}`, REGRESSED_FILTER);
    expect(doctored, "fixture invariant: filter substring must exist in hook source").not.toBe(original);

    vm.createContext(sandbox);
    vm.runInContext(doctored, sandbox, { filename: "sharing.pb.js (doctored)" });

    if (!postRedeem) throw new Error("POST /api/sharing/redeem handler was not registered");
    const handler: Handler = postRedeem;

    const user = makeRecord("USER0000000099", {
      __collection: "users",
      recipe_boxes: [],
    });
    const box = makeRecord("BOX00000000099", {
      __collection: "recipe_boxes",
      name: "Filter Regression",
      owners: ["OWNER000000099"],
    });
    const invite = makeRecord("INVITE00000099", {
      __collection: "sharing_invites",
      code: "REGRESS1",
      redeemed: false,
      target_type: "box",
      target_id: box.id,
      expires_at: "",
    });
    records.set(user.id, user);
    records.set(box.id, box);
    records.set(invite.id, invite);

    const e = {
      auth: { id: user.id },
      requestInfo: () => ({ body: { code: "REGRESS1" } }),
      json: (status: number, body: unknown) => ({ status, body }),
    };
    handler(e);

    // The doctored hook produced a regressed filter; the test's contract
    // assertion catches it. If sharing.pb.js were silently changed to use
    // this filter, the in-suite assertion would surface the drift.
    expect(filterCalls).toHaveLength(1);
    expect(filterCalls[0].filter).toBe(REGRESSED_FILTER);
    // And critically: the canonical assertion fails for this regressed form.
    expect(filterCalls[0].filter).not.toBe(EXPECTED_INVITE_FILTER);
  });
});
