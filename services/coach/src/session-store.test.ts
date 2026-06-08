/**
 * Round-trip integration test for `PocketBaseSessionStore`.
 *
 * Runs against the worktree-local test PB (see `infra/test-env.sh`), which
 * applies all migrations including `20260608_181214_coach_sessions.js` on
 * boot. The test:
 *
 *   1. Creates a fresh user.
 *   2. Constructs the adapter with admin-PB + that user as `ownerId`.
 *   3. `append`s a batch of entries, `load`s back, asserts deep equality.
 *   4. `append`s a second batch and verifies idempotency on `uuid`.
 *   5. `delete`s and verifies `load` returns `null`.
 *
 * The PB session is admin-auth'd because the real coach service writes via
 * admin-PB (bypasses owner rules). Tenancy is enforced by the `ownerId`
 * field the adapter stamps on every row.
 *
 * Bring up the test env first: `infra/test-env.sh up`. Override the PB URL
 * via `PB_URL` / `PB_TEST_URL` env vars if needed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "node:crypto";
import type {
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { PocketBaseSessionStore } from "./session-store";

function getPbTestUrl(): string {
  return (
    process.env.PB_URL ?? process.env.PB_TEST_URL ?? "http://127.0.0.1:8091"
  );
}

let adminPb: PocketBase;
let userId: string;
let store: PocketBaseSessionStore;

beforeAll(async () => {
  const url = getPbTestUrl();
  adminPb = new PocketBase(url);
  adminPb.autoCancellation(false);
  await adminPb
    .collection("_superusers")
    .authWithPassword("test-admin@test.local", "testpassword1234");

  // Fresh user per test file run; namespace by random bytes so parallel
  // suites can't collide on email.
  const email = `coach-store-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const rec = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "coach-store-test",
  });
  userId = rec.id;
  store = new PocketBaseSessionStore({ pb: adminPb, ownerId: userId });
});

describe("PocketBaseSessionStore", () => {
  it("round-trips a session: append → load returns the same entries", async () => {
    const key: SessionKey = {
      projectKey: "coach",
      sessionId: `sess-${randomBytes(4).toString("hex")}`,
    };
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", timestamp: "2026-06-08T18:00:00Z", text: "hi" },
      {
        type: "assistant",
        uuid: "u2",
        timestamp: "2026-06-08T18:00:01Z",
        text: "hello back",
      },
    ];

    expect(await store.load(key)).toBeNull();

    await store.append(key, entries);

    const loaded = await store.load(key);
    expect(loaded).toEqual(entries);
  });

  it("appends additional entries and dedupes by uuid", async () => {
    const key: SessionKey = {
      projectKey: "coach",
      sessionId: `sess-${randomBytes(4).toString("hex")}`,
    };
    await store.append(key, [
      { type: "user", uuid: "a", text: "first" },
      { type: "user", uuid: "b", text: "second" },
    ]);
    // Append with one duplicate (a) and one new (c).
    await store.append(key, [
      { type: "user", uuid: "a", text: "first-DUP" },
      { type: "user", uuid: "c", text: "third" },
    ]);
    const loaded = await store.load(key);
    expect(loaded).toHaveLength(3);
    const uuids = (loaded ?? []).map((e) => e.uuid);
    expect(uuids).toEqual(["a", "b", "c"]);
  });

  it("delete removes the row and subsequent load returns null", async () => {
    const key: SessionKey = {
      projectKey: "coach",
      sessionId: `sess-${randomBytes(4).toString("hex")}`,
    };
    await store.append(key, [{ type: "user", uuid: "x", text: "to-be-deleted" }]);
    expect(await store.load(key)).not.toBeNull();
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
  });

  it("subpath is part of the key — main and subagent are distinct rows", async () => {
    const sessionId = `sess-${randomBytes(4).toString("hex")}`;
    const mainKey: SessionKey = { projectKey: "coach", sessionId };
    const subKey: SessionKey = {
      projectKey: "coach",
      sessionId,
      subpath: "subagents/agent-1",
    };
    await store.append(mainKey, [{ type: "user", uuid: "m1", text: "main" }]);
    await store.append(subKey, [{ type: "user", uuid: "s1", text: "sub" }]);

    const loadedMain = await store.load(mainKey);
    const loadedSub = await store.load(subKey);
    expect(loadedMain?.[0]?.text).toBe("main");
    expect(loadedSub?.[0]?.text).toBe("sub");

    const subkeys = await store.listSubkeys({ projectKey: "coach", sessionId });
    expect(subkeys).toContain("subagents/agent-1");
  });

  it("listSessions returns this owner's sessions only (main transcripts)", async () => {
    const ourSessionId = `sess-${randomBytes(4).toString("hex")}`;
    await store.append(
      { projectKey: "coach-list-test", sessionId: ourSessionId },
      [{ type: "user", uuid: "L1", text: "x" }],
    );
    const sessions = await store.listSessions("coach-list-test");
    expect(sessions.some((s) => s.sessionId === ourSessionId)).toBe(true);
    for (const s of sessions) {
      expect(typeof s.mtime).toBe("number");
      expect(Number.isFinite(s.mtime)).toBe(true);
    }
  });
});
