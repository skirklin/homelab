/**
 * `PocketBaseSessionStore` unit tests.
 *
 * Stubs the PB client (matches `packages/backend/src/pocketbase/life.test.ts`
 * pattern). DOES NOT require a real PB instance — runs anywhere `vitest` runs,
 * which means it passes inside the shared `pnpm test` pre-deploy gate without
 * needing `coach_sessions` to exist in the test env's PB schema.
 *
 * History: the first version of this file used real PB integration
 * (`infra/test-env.sh up` + admin auth + actual reads/writes). That broke the
 * deploy gate for sibling sessions whose test-env PB image hadn't picked up
 * the `coach_sessions` migration yet. The end-to-end round-trip confidence
 * lived in the test for a few hours, then moved to manual verification + the
 * authz-mirror drift test (which DOES run against live PB and catches schema
 * drift on the collection itself).
 *
 * If you ever want the round-trip back, add a separate `*.e2e.test.ts` file
 * that's NOT picked up by the default `pnpm test` glob.
 */
import { describe, it, expect, vi } from "vitest";
import type PocketBase from "pocketbase";
import type {
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { PocketBaseSessionStore } from "./session-store";

interface StubbedPb {
  pb: PocketBase;
  collection: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  getFirstListItem: ReturnType<typeof vi.fn>;
  getFullList: ReturnType<typeof vi.fn>;
}

/**
 * Build a stubbed PB client whose `collection(...)` returns a per-method
 * spy. The adapter only touches the methods listed below; anything else
 * would surface as `undefined is not a function`, which is what we want
 * (signals an unverified surface).
 */
function makeStub(): StubbedPb {
  const create = vi.fn();
  const update = vi.fn();
  const del = vi.fn();
  const getFirstListItem = vi.fn();
  const getFullList = vi.fn();
  const collection = vi.fn().mockReturnValue({
    create,
    update,
    delete: del,
    getFirstListItem,
    getFullList,
  });
  // The adapter calls `pb.filter(...)` to build PB filter strings. A
  // pass-through is enough; the real PB SDK does string interpolation but
  // we're not testing that.
  const filter = vi.fn((s: string, _vars: Record<string, unknown>) => s);
  const pb = { collection, filter } as unknown as PocketBase;
  return { pb, collection, create, update, del, getFirstListItem, getFullList };
}

/** A `ClientResponseError`-shaped 404 for stubs that should report "not found". */
function notFoundError(): Error & { status: number } {
  const err = new Error("not found") as Error & { status: number };
  err.status = 404;
  return err;
}

describe("PocketBaseSessionStore", () => {
  it("constructor rejects when ownerId is missing", () => {
    const { pb } = makeStub();
    expect(
      () => new PocketBaseSessionStore({ pb, ownerId: "" }),
    ).toThrow(/ownerId/);
  });

  describe("append", () => {
    it("is a no-op for an empty entries array (zero PB calls)", async () => {
      const stub = makeStub();
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "p", sessionId: "s" };

      await store.append(key, []);

      expect(stub.collection).not.toHaveBeenCalled();
      expect(stub.create).not.toHaveBeenCalled();
      expect(stub.update).not.toHaveBeenCalled();
    });

    it("creates a new row when no row exists for the key (subpath normalized to \"\")", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "coach", sessionId: "sess-1" };
      const entries: SessionStoreEntry[] = [
        { type: "user", uuid: "a", text: "hi" } as unknown as SessionStoreEntry,
      ];

      await store.append(key, entries);

      expect(stub.create).toHaveBeenCalledTimes(1);
      expect(stub.create).toHaveBeenCalledWith({
        owner: "u1",
        project_key: "coach",
        session_id: "sess-1",
        subpath: "", // undefined → "" via normSubpath for the compound index
        entries,
      });
      expect(stub.update).not.toHaveBeenCalled();
    });

    it("updates the existing row and dedupes incoming entries by uuid", async () => {
      const stub = makeStub();
      const existing = {
        id: "row-1",
        owner: "u1",
        project_key: "coach",
        session_id: "sess-1",
        subpath: "",
        entries: [
          { type: "user", uuid: "a", text: "first" } as unknown as SessionStoreEntry,
          { type: "user", uuid: "b", text: "second" } as unknown as SessionStoreEntry,
        ],
        last_activity: "2026-06-08T12:00:00Z",
      };
      stub.getFirstListItem.mockResolvedValueOnce(existing);
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "coach", sessionId: "sess-1" };

      // Includes one duplicate (a) and one new (c). The dup is dropped.
      await store.append(key, [
        { type: "user", uuid: "a", text: "first-DUP" } as unknown as SessionStoreEntry,
        { type: "user", uuid: "c", text: "third" } as unknown as SessionStoreEntry,
      ]);

      expect(stub.update).toHaveBeenCalledTimes(1);
      const [rowId, patch] = stub.update.mock.calls[0]!;
      expect(rowId).toBe("row-1");
      const merged = (patch as { entries: SessionStoreEntry[] }).entries;
      expect(merged.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
      expect(stub.create).not.toHaveBeenCalled();
    });

    it("no-ops when every incoming entry's uuid was already seen", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockResolvedValueOnce({
        id: "row-1",
        owner: "u1",
        project_key: "coach",
        session_id: "sess-1",
        subpath: "",
        entries: [
          { type: "user", uuid: "a" } as unknown as SessionStoreEntry,
          { type: "user", uuid: "b" } as unknown as SessionStoreEntry,
        ],
        last_activity: "2026-06-08T12:00:00Z",
      });
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "coach", sessionId: "sess-1" };

      await store.append(key, [
        { type: "user", uuid: "a" } as unknown as SessionStoreEntry,
        { type: "user", uuid: "b" } as unknown as SessionStoreEntry,
      ]);

      expect(stub.update).not.toHaveBeenCalled();
      expect(stub.create).not.toHaveBeenCalled();
    });

    it("preserves entries without a uuid (they're appended unconditionally)", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "coach", sessionId: "sess-1" };
      const entries: SessionStoreEntry[] = [
        { type: "user", text: "no-uuid" } as unknown as SessionStoreEntry,
        { type: "user", text: "also-no-uuid" } as unknown as SessionStoreEntry,
      ];

      await store.append(key, entries);

      expect(stub.create).toHaveBeenCalledWith(
        expect.objectContaining({ entries }),
      );
    });
  });

  describe("load", () => {
    it("returns null when the underlying PB query 404s", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });
      const key: SessionKey = { projectKey: "p", sessionId: "s" };

      const result = await store.load(key);
      expect(result).toBeNull();
    });

    it("returns the row's entries when the row exists", async () => {
      const stub = makeStub();
      const entries: SessionStoreEntry[] = [
        { type: "user", uuid: "x", text: "y" } as unknown as SessionStoreEntry,
      ];
      stub.getFirstListItem.mockResolvedValueOnce({
        id: "row-1",
        owner: "u1",
        project_key: "p",
        session_id: "s",
        subpath: "",
        entries,
        last_activity: "2026-06-08T12:00:00Z",
      });
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      const result = await store.load({ projectKey: "p", sessionId: "s" });
      expect(result).toEqual(entries);
    });

    it("returns [] when the row's entries field is null/missing", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockResolvedValueOnce({
        id: "row-1",
        owner: "u1",
        project_key: "p",
        session_id: "s",
        subpath: "",
        entries: null,
        last_activity: "2026-06-08T12:00:00Z",
      });
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      const result = await store.load({ projectKey: "p", sessionId: "s" });
      expect(result).toEqual([]);
    });

    it("rethrows non-404 errors (don't silently lose data)", async () => {
      const stub = makeStub();
      const boom = new Error("PB 500") as Error & { status: number };
      boom.status = 500;
      stub.getFirstListItem.mockRejectedValueOnce(boom);
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      await expect(
        store.load({ projectKey: "p", sessionId: "s" }),
      ).rejects.toThrow(/PB 500/);
    });
  });

  describe("delete", () => {
    it("is a no-op when the row doesn't exist", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      await store.delete({ projectKey: "p", sessionId: "s" });
      expect(stub.del).not.toHaveBeenCalled();
    });

    it("calls PB delete with the row id when the row exists", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockResolvedValueOnce({
        id: "row-7",
        owner: "u1",
        project_key: "p",
        session_id: "s",
        subpath: "",
        entries: [],
        last_activity: "2026-06-08T12:00:00Z",
      });
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      await store.delete({ projectKey: "p", sessionId: "s" });
      expect(stub.del).toHaveBeenCalledTimes(1);
      expect(stub.del).toHaveBeenCalledWith("row-7");
    });
  });

  describe("listSessions / listSubkeys", () => {
    it("listSessions maps last_activity to a finite numeric mtime", async () => {
      const stub = makeStub();
      stub.getFullList.mockResolvedValueOnce([
        { session_id: "s-1", last_activity: "2026-06-08T12:00:00Z" },
        { session_id: "s-2", last_activity: "2026-06-08T12:05:00Z" },
      ]);
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      const sessions = await store.listSessions("coach");
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.sessionId).toBe("s-1");
      expect(Number.isFinite(sessions[0]?.mtime ?? NaN)).toBe(true);
      expect(sessions[1]?.mtime).toBeGreaterThan(sessions[0]?.mtime ?? 0);
    });

    it("listSubkeys returns the subpath strings only", async () => {
      const stub = makeStub();
      stub.getFullList.mockResolvedValueOnce([
        { subpath: "subagents/agent-1" },
        { subpath: "subagents/agent-2" },
      ]);
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      const subkeys = await store.listSubkeys({
        projectKey: "coach",
        sessionId: "sess-1",
      });
      expect(subkeys).toEqual(["subagents/agent-1", "subagents/agent-2"]);
    });
  });

  describe("subpath normalization", () => {
    it("treats undefined subpath as \"\" (the index value)", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      await store.append({ projectKey: "p", sessionId: "s" }, [
        { type: "user", uuid: "a" } as unknown as SessionStoreEntry,
      ]);

      expect(stub.create).toHaveBeenCalledWith(
        expect.objectContaining({ subpath: "" }),
      );
    });

    it("preserves explicit non-empty subpath verbatim", async () => {
      const stub = makeStub();
      stub.getFirstListItem.mockRejectedValueOnce(notFoundError());
      const store = new PocketBaseSessionStore({ pb: stub.pb, ownerId: "u1" });

      await store.append(
        { projectKey: "p", sessionId: "s", subpath: "subagents/sub-1" },
        [{ type: "user", uuid: "a" } as unknown as SessionStoreEntry],
      );

      expect(stub.create).toHaveBeenCalledWith(
        expect.objectContaining({ subpath: "subagents/sub-1" }),
      );
    });
  });
});
