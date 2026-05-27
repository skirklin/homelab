/**
 * PocketBaseLifeBackend tests — focused on the empty-payload invariant
 * (DATA_COLLECTION.md F1). The throw fires before any wpb interaction, so
 * a minimal stub PB + wpb + mirror is enough; we don't need the full
 * realtime/mirror harness used by shopping.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type PocketBase from "pocketbase";
import { PocketBaseLifeBackend } from "./life";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror } from "../wrapped-pb/mirror";

function makeBackend(): {
  backend: PocketBaseLifeBackend;
  createSpy: ReturnType<typeof vi.fn>;
} {
  // The invariant rejects before any of these are touched. They only exist
  // so the constructor + type system are satisfied.
  const createSpy = vi.fn();
  const wpb = {
    collection: () => ({ create: createSpy }),
  } as unknown as WrappedPocketBase;
  const mirror = {} as PBMirror;
  const pb = (() => ({})) as unknown as () => PocketBase;
  return { backend: new PocketBaseLifeBackend(pb, wpb, mirror), createSpy };
}

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
});
