/**
 * PocketBaseLifeBackend tests — focused on the empty-payload invariant
 * (DATA_COLLECTION.md F1). The throw fires before any wpb interaction, so
 * a minimal stub PB + wpb + mirror is enough; we don't need the full
 * realtime/mirror harness used by shopping.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type PocketBase from "pocketbase";
import { PocketBaseLifeBackend } from "./life";
import { DEFAULT_LIFE_MANIFEST } from "../life-manifest-default";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror } from "../wrapped-pb/mirror";

function makeBackend(): {
  backend: PocketBaseLifeBackend;
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
} {
  // The invariant rejects before any of these are touched. They only exist
  // so the constructor + type system are satisfied.
  const createSpy = vi.fn();
  const updateSpy = vi.fn();
  const wpb = {
    collection: () => ({ create: createSpy, update: updateSpy }),
  } as unknown as WrappedPocketBase;
  const mirror = {} as PBMirror;
  const pb = (() => ({})) as unknown as () => PocketBase;
  return { backend: new PocketBaseLifeBackend(pb, wpb, mirror), createSpy, updateSpy };
}

/**
 * getOrCreateLog stub: drives the owner-filter getList (read) on a plain PB
 * client and the create on the wpb wrapper, mirroring the real impl. `owned`
 * controls whether an existing log is returned (seed-preservation path) or a
 * fresh one is created (seed-on-create path).
 */
function makeLogBackend(opts: { owned?: Record<string, unknown> | null } = {}): {
  backend: PocketBaseLifeBackend;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const owned = opts.owned ?? null;
  const createSpy = vi.fn((payload: Record<string, unknown>) => Promise.resolve(payload));
  const wpb = {
    collection: () => ({ create: createSpy, update: vi.fn() }),
  } as unknown as WrappedPocketBase;
  const pb = (() => ({
    filter: (s: string) => s,
    collection: () => ({
      getList: () =>
        Promise.resolve({ items: owned ? [owned] : [] }),
    }),
  })) as unknown as () => PocketBase;
  const mirror = {} as PBMirror;
  return { backend: new PocketBaseLifeBackend(pb, wpb, mirror), createSpy };
}

describe("PocketBaseLifeBackend.getOrCreateLog — manifest seeding (P1)", () => {
  it("seeds an EMPTY manifest on create (no default trackables/views/notifications)", async () => {
    const { backend, createSpy } = makeLogBackend({ owned: null });
    const log = await backend.getOrCreateLog("user-new");

    // The create payload carries the empty default manifest.
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [payload] = createSpy.mock.calls[0];
    expect((payload as { manifest: typeof DEFAULT_LIFE_MANIFEST }).manifest).toEqual(
      DEFAULT_LIFE_MANIFEST,
    );
    // Explicit empty arrays — NOT undefined (the in-app editors edit these
    // arrays in place; undefined would make them render the DEFAULT_* fallback
    // and throw `*_not_found` on the first edit).
    expect((payload as { manifest: { trackables: unknown[]; views: unknown[]; notifications: unknown[] } }).manifest).toEqual({
      trackables: [],
      views: [],
      notifications: [],
    });

    // And the mapped LifeLog surfaces an empty manifest.
    expect(log.manifest).toEqual({ trackables: [], views: [], notifications: [] });
  });

  it("preserves an existing log's manifest (does NOT re-seed or overwrite)", async () => {
    const existingManifest = {
      trackables: [{ id: "custom", label: "Custom", shape: "took" }],
    };
    const { backend, createSpy } = makeLogBackend({
      owned: { id: "log-existing", manifest: existingManifest },
    });
    const log = await backend.getOrCreateLog("user-existing");

    expect(createSpy).not.toHaveBeenCalled();
    expect(log.id).toBe("log-existing");
    expect(log.manifest).toEqual(existingManifest);
  });

  it("surfaces a null manifest for a legacy row that predates the backfill", async () => {
    const { backend } = makeLogBackend({ owned: { id: "log-legacy" } });
    const log = await backend.getOrCreateLog("user-legacy");
    expect(log.manifest).toBeNull();
  });
});

describe("PocketBaseLifeBackend.addEvent — empty-payload invariant (F1)", () => {
  it("throws when entries[] is empty and does not touch the backend", async () => {
    const { backend, createSpy } = makeBackend();
    await expect(
      backend.addEvent("log123", "sleep", [], "user1"),
    ).rejects.toThrow(/empty entries/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("includes the offending subject_id in the error so debugging is easy", async () => {
    const { backend } = makeBackend();
    await expect(
      backend.addEvent("log123", "morning_session", [], "user1"),
    ).rejects.toThrow(/morning_session/);
  });

  it("rejects when entries is not even an array (defense in depth)", async () => {
    const { backend, createSpy } = makeBackend();
    await expect(
      // Force the bad-shape path; the runtime guard catches non-arrays too.
      backend.addEvent("log123", "sleep", undefined as unknown as never, "user1"),
    ).rejects.toThrow(/empty entries/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("accepts a non-empty entries[] and forwards to the underlying collection", async () => {
    const { backend, createSpy } = makeBackend();
    createSpy.mockResolvedValueOnce({ id: "ev1" });
    const id = await backend.addEvent(
      "log123",
      "sleep",
      [{ name: "duration", type: "number", value: 420, unit: "min" }],
      "user1",
    );
    expect(typeof id).toBe("string");
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [payload] = createSpy.mock.calls[0];
    expect(payload).toMatchObject({
      log: "log123",
      subject_id: "sleep",
      created_by: "user1",
    });
    expect((payload as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("passes a per-event requestKey so concurrent creates never auto-cancel", async () => {
    // Regression for "WrappedPbError: The request was autocancelled" on a
    // session-wizard submit: N per-item events written with Promise.all are N
    // concurrent creates to the SAME life_events collection. PocketBase's SDK
    // keys in-flight requests by method+path by default, so without a distinct
    // requestKey all-but-one get auto-cancelled. addEvent must hand each create
    // a unique requestKey derived from the (locally generated) event id.
    const { backend, createSpy } = makeBackend();
    createSpy.mockResolvedValue({ id: "ev" });

    // Simulate the evening session: 3 per-item events written concurrently.
    const subjects = ["energy", "gratitude", "highlights"];
    const ids = await Promise.all(
      subjects.map((s) =>
        backend.addEvent("log123", s, [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], "user1", {
          labels: { view: "evening", view_run: "2026-06-17T00:00:00.000Z" },
        }),
      ),
    );

    // All N writes completed (none swallowed/cancelled) and reached the backend.
    expect(ids).toHaveLength(3);
    expect(createSpy).toHaveBeenCalledTimes(3);

    // Every create carries an opts object with a requestKey...
    const requestKeys = createSpy.mock.calls.map(([payload, opts]) => {
      expect(opts).toMatchObject({ requestKey: expect.any(String) });
      // ...keyed to the event's own id, so siblings can't collide.
      expect((opts as { requestKey: string }).requestKey).toBe(
        `life-event-${(payload as { id: string }).id}`,
      );
      return (opts as { requestKey: string }).requestKey;
    });
    // ...and the keys are all DISTINCT — the property that defeats autocancel.
    expect(new Set(requestKeys).size).toBe(3);
  });
});

describe("PocketBaseLifeBackend.updateEvent — empty-payload invariant (F1)", () => {
  it("throws when entries is explicitly set to [] and does not touch the backend", async () => {
    const { backend, updateSpy } = makeBackend();
    await expect(
      backend.updateEvent("ev1", { entries: [] }),
    ).rejects.toThrow(/non-empty array/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects when entries is set to a non-array (defense in depth)", async () => {
    const { backend, updateSpy } = makeBackend();
    await expect(
      backend.updateEvent("ev1", { entries: "not-an-array" as unknown as never }),
    ).rejects.toThrow(/non-empty array/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("includes the offending eventId in the error so debugging is easy", async () => {
    const { backend } = makeBackend();
    await expect(
      backend.updateEvent("ev-deadbeef", { entries: [] }),
    ).rejects.toThrow(/ev-deadbeef/);
  });

  it("allows updates that omit entries (e.g. timestamp-only edits)", async () => {
    const { backend, updateSpy } = makeBackend();
    updateSpy.mockResolvedValueOnce({});
    await backend.updateEvent("ev1", { timestamp: new Date("2026-05-27T10:00:00Z") });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [, patch] = updateSpy.mock.calls[0];
    expect(patch).toHaveProperty("timestamp");
    expect(patch).not.toHaveProperty("entries");
  });

  it("accepts a non-empty entries[] and forwards to the underlying collection", async () => {
    const { backend, updateSpy } = makeBackend();
    updateSpy.mockResolvedValueOnce({});
    await backend.updateEvent("ev1", {
      entries: [{ name: "duration", type: "number", value: 480, unit: "min" }],
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [eventId, patch] = updateSpy.mock.calls[0];
    expect(eventId).toBe("ev1");
    expect((patch as { entries: unknown[] }).entries).toHaveLength(1);
  });
});
