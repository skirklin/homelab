/**
 * End-to-end tests for Life Tracker using Firebase emulators
 *
 * Run with: npm test
 * Requires Firebase emulators running: firebase emulators:start
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createTestUser,
  cleanupTestFirebase,
  TestCleanup,
  createTestLifeLog,
  createTestEntry,
  type TestContext,
} from "@kirkl/shared";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  orderBy,
  limit,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Life Tracker E2E Tests", () => {
  beforeAll(async () => {
    ctx = await initTestFirebase();
    await createTestUser(ctx);
    cleanup = new TestCleanup();
  });

  afterAll(async () => {
    await cleanupTestFirebase(ctx);
  });

  afterEach(async () => {
    await cleanup.cleanup();
  });

  describe("Life Log Creation", () => {
    it("should auto-create a life log for new user", async () => {
      // Simulate getOrCreateUserLog
      const userRef = doc(ctx.db, "users", ctx.testUser!.uid);
      let userSnap = await getDoc(userRef);

      // User doesn't have a log yet
      if (!userSnap.exists() || !userSnap.data()?.lifeLogId) {
        // Create a new log
        const logRef = await createTestLifeLog(ctx, cleanup);

        // Save log ID to user profile
        cleanup.track(userRef);
        await setDoc(userRef, { lifeLogId: logRef.id }, { merge: true });

        userSnap = await getDoc(userRef);
        expect(userSnap.data()?.lifeLogId).toBe(logRef.id);

        // Verify log exists
        const logSnap = await getDoc(logRef);
        expect(logSnap.exists()).toBe(true);
        expect(logSnap.data()?.owners).toContain(ctx.testUser!.uid);
      }
    });
  });

  describe("Activity Tracking", () => {
    it("should start and stop a sleep activity", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup, { name: "Test Life Log" });

      // Start sleep (endTime null indicates activity in progress)
      const startTime = Timestamp.now();
      const entriesRef = collection(ctx.db, "lifeLogs", logRef.id, "entries");
      const { addDoc } = await import("firebase/firestore");
      const entryRef = await addDoc(entriesRef, {
        type: "sleep",
        startTime,
        endTime: null,
        duration: null,
        notes: "",
        createdBy: ctx.testUser!.uid,
        createdAt: startTime,
      });
      cleanup.track(entryRef);

      // Verify entry was created
      let entrySnap = await getDoc(entryRef);
      expect(entrySnap.exists()).toBe(true);
      expect(entrySnap.data()?.type).toBe("sleep");
      expect(entrySnap.data()?.endTime).toBeNull();

      // Stop sleep (simulate time passing)
      const endTime = Timestamp.now();
      const durationMinutes = Math.round(
        (endTime.toMillis() - startTime.toMillis()) / 60000
      );
      await updateDoc(entryRef, {
        endTime,
        duration: durationMinutes,
      });

      // Verify entry was updated
      entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.endTime).toBeDefined();
      expect(entrySnap.data()?.duration).toBeDefined();
    });

    it("should add a manual activity entry", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup);

      // Add a gym session from earlier today
      const twoHoursAgo = new Date();
      twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);
      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "gym",
        startTime: Timestamp.fromDate(twoHoursAgo),
        endTime: Timestamp.fromDate(oneHourAgo),
        duration: 60,
        notes: "Leg day",
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.type).toBe("gym");
      expect(entrySnap.data()?.duration).toBe(60);
      expect(entrySnap.data()?.notes).toBe("Leg day");
    });

    it("should track all activity types", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup);
      const activityTypes = ["sleep", "gym", "stretching", "work"];

      for (const type of activityTypes) {
        await createTestEntry(ctx, logRef.id, cleanup, {
          type,
          duration: 30,
          notes: `Test ${type}`,
        });
      }

      // Verify all types were created
      const entries = await getDocs(collection(ctx.db, "lifeLogs", logRef.id, "entries"));
      const types = entries.docs.map((d) => d.data().type);
      for (const type of activityTypes) {
        expect(types).toContain(type);
      }
    });
  });

  describe("Entry Queries", () => {
    it("should query entries ordered by start time", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup, { name: "Query Test Log" });

      // Add some entries with different times
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        const entryTime = new Date(now.getTime() - i * 3600000); // 1 hour apart
        await createTestEntry(ctx, logRef.id, cleanup, {
          type: "work",
          startTime: Timestamp.fromDate(entryTime),
          endTime: Timestamp.fromDate(entryTime),
          duration: 60,
          notes: `Entry ${i}`,
        });
      }

      const entriesRef = collection(ctx.db, "lifeLogs", logRef.id, "entries");
      const q = query(entriesRef, orderBy("startTime", "desc"), limit(3));
      const entries = await getDocs(q);

      expect(entries.size).toBe(3);

      // Verify they're in descending order
      const times = entries.docs.map((d) => d.data().startTime.toMillis());
      expect(times[0]).toBeGreaterThan(times[1]);
      expect(times[1]).toBeGreaterThan(times[2]);
    });
  });

  describe("Entry Updates and Deletes", () => {
    it("should update entry notes", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup, { name: "Update Test" });

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "stretching",
        duration: 15,
        notes: "Original notes",
      });

      await updateDoc(entryRef, { notes: "Updated notes" });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.notes).toBe("Updated notes");
    });

    it("should delete an entry", async () => {
      const logRef = await createTestLifeLog(ctx, cleanup, { name: "Delete Test" });

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "gym",
        duration: 45,
        notes: "To be deleted",
      });

      const { deleteDoc } = await import("firebase/firestore");
      await deleteDoc(entryRef);

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.exists()).toBe(false);
    });
  });
});
