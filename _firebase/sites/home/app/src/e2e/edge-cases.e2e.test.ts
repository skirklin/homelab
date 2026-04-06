/**
 * Edge case and corner case tests for Life Tracker
 *
 * Tests unusual scenarios, race conditions, and error handling
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  initTestFirebase,
  createUserWithoutSignIn,
  signInAsUser,
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
  deleteDoc,
  updateDoc,
  addDoc,
  arrayRemove,
  Timestamp,
} from "firebase/firestore";

let ctx: TestContext;
let cleanup: TestCleanup;

describe("Life Tracker Edge Cases", () => {
  beforeAll(async () => {
    ctx = await initTestFirebase();
    cleanup = new TestCleanup();
  });

  afterAll(async () => {
    await cleanupTestFirebase(ctx);
  });

  afterEach(async () => {
    await cleanup.cleanup();
  });

  describe("Activity Overlap Cases", () => {
    it("should handle starting sleep while already sleeping (overlapping activities)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      // Start sleep at 10pm
      const sleep1Start = new Date();
      sleep1Start.setHours(22, 0, 0, 0);

      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "sleep",
        startTime: Timestamp.fromDate(sleep1Start),
        endTime: null,
        duration: null,
        notes: "First sleep",
      });

      // Start another sleep at 11pm (overlapping - user forgot to end first)
      const sleep2Start = new Date();
      sleep2Start.setHours(23, 0, 0, 0);

      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "sleep",
        startTime: Timestamp.fromDate(sleep2Start),
        endTime: null,
        duration: null,
        notes: "Second sleep (overlap)",
      });

      // Both entries exist (Firestore doesn't prevent overlaps)
      const entries = await getDocs(collection(ctx.db, "lifeLogs", logRef.id, "entries"));
      const sleepEntries = entries.docs.filter((d) => d.data().type === "sleep");
      expect(sleepEntries.length).toBe(2);
    });

    it("should handle multiple activities at the same time", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const sameTime = Timestamp.now();

      // Add multiple activities with exact same start time
      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "work",
        startTime: sameTime,
        endTime: sameTime,
        duration: 60,
        notes: "Working",
      });

      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "stretching",
        startTime: sameTime,
        endTime: sameTime,
        duration: 15,
        notes: "Stretching while working?",
      });

      // Both exist
      const entries = await getDocs(collection(ctx.db, "lifeLogs", logRef.id, "entries"));
      expect(entries.size).toBe(2);
    });
  });

  describe("Time Edge Cases", () => {
    it("should handle end time before start time (invalid state)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() + 3600000); // Start is 1 hour AFTER end

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "gym",
        startTime: Timestamp.fromDate(startTime),
        endTime: Timestamp.fromDate(endTime),
        duration: -60, // Negative duration
        notes: "Time travel workout",
      });

      // Entry exists with invalid data (Firestore doesn't validate)
      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.exists()).toBe(true);
      expect(entrySnap.data()?.duration).toBe(-60);

      // Verify start > end
      const start = entrySnap.data()?.startTime.toMillis();
      const end = entrySnap.data()?.endTime.toMillis();
      expect(start).toBeGreaterThan(end);
    });

    it("should handle entries with future dates", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      // Schedule a future workout (next week)
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "gym",
        startTime: Timestamp.fromDate(nextWeek),
        endTime: Timestamp.fromDate(nextWeek),
        duration: 60,
        notes: "Future gym session",
      });

      const entrySnap = await getDoc(entryRef);
      const startTime = entrySnap.data()?.startTime.toDate();
      expect(startTime.getTime()).toBeGreaterThan(Date.now());
    });

    it("should handle entries with very old dates", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      // Entry from 10 years ago
      const tenYearsAgo = new Date();
      tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "sleep",
        startTime: Timestamp.fromDate(tenYearsAgo),
        endTime: Timestamp.fromDate(tenYearsAgo),
        duration: 480,
        notes: "Historical sleep data",
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.exists()).toBe(true);
    });

    it("should handle zero duration activities", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const now = Timestamp.now();

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "stretching",
        startTime: now,
        endTime: now,
        duration: 0,
        notes: "Instant stretch",
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.duration).toBe(0);
    });

    it("should handle very long duration activities", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      // 7 day work session (10080 minutes)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "work",
        startTime: Timestamp.fromDate(weekAgo),
        endTime: Timestamp.now(),
        duration: 10080,
        notes: "Week-long crunch",
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.duration).toBe(10080);
    });
  });

  describe("Entry State Edge Cases", () => {
    it("should handle ending an already ended activity", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "sleep",
        duration: 30,
        notes: "Already ended",
      });

      // Try to end it again with different time
      const newEndTime = Timestamp.now();
      await updateDoc(entryRef, {
        endTime: newEndTime,
        duration: 60,
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.duration).toBe(60);
    });

    it("should handle activity with missing type", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const entriesRef = collection(ctx.db, "lifeLogs", logRef.id, "entries");

      // Entry without type field (bypass helper to create invalid data)
      const entryRef = await addDoc(entriesRef, {
        startTime: Timestamp.now(),
        endTime: Timestamp.now(),
        duration: 30,
        notes: "What kind of activity?",
        createdBy: user.localId,
        createdAt: Timestamp.now(),
      });
      cleanup.track(entryRef);

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.exists()).toBe(true);
      expect(entrySnap.data()?.type).toBeUndefined();
    });

    it("should handle activity with custom/unknown type", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "underwater-basket-weaving",
        duration: 120,
        notes: "Unusual hobby",
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.type).toBe("underwater-basket-weaving");
    });

    it("should handle very long notes", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });
      const longNotes = "A".repeat(50000);

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "work",
        duration: 60,
        notes: longNotes,
      });

      const entrySnap = await getDoc(entryRef);
      expect(entrySnap.data()?.notes.length).toBe(50000);
    });
  });

  describe("Multi-user Scenarios", () => {
    it("should handle User A deleting log while User B has entries in it", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [userA.localId] });

      // Add User B
      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(logRef, { owners: [userA.localId, userB.localId] });

      // User B adds entries
      await signInAsUser(ctx, userB);
      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "gym",
        duration: 60,
        notes: "User B's workout",
      });

      // User A deletes the log
      await signInAsUser(ctx, userA);
      await deleteDoc(logRef);

      // Log is gone
      const logSnap = await getDoc(logRef);
      expect(logSnap.exists()).toBe(false);
    });

    it("should handle User A removing User B from shared log", async () => {
      const userA = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, userA);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [userA.localId] });

      const userB = await createUserWithoutSignIn(ctx);
      await updateDoc(logRef, { owners: [userA.localId, userB.localId] });

      // User B adds an entry
      await signInAsUser(ctx, userB);
      await createTestEntry(ctx, logRef.id, cleanup, {
        type: "sleep",
        endTime: null,
        duration: null,
        notes: "Going to sleep",
      });

      // User A removes User B
      await signInAsUser(ctx, userA);
      await updateDoc(logRef, { owners: arrayRemove(userB.localId) });

      // User B can no longer add entries
      await signInAsUser(ctx, userB);
      const entriesRef = collection(ctx.db, "lifeLogs", logRef.id, "entries");
      await expect(
        addDoc(entriesRef, {
          type: "gym",
          startTime: Timestamp.now(),
          endTime: null,
          duration: null,
          notes: "Should fail",
          createdBy: userB.localId,
          createdAt: Timestamp.now(),
        })
      ).rejects.toThrow();
    });
  });

  describe("Log State Edge Cases", () => {
    it("should handle log with no entries", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      const entries = await getDocs(collection(ctx.db, "lifeLogs", logRef.id, "entries"));
      expect(entries.empty).toBe(true);
    });

    it("should handle user with multiple life logs", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create multiple logs for same user
      const log1 = await createTestLifeLog(ctx, cleanup, { name: "Personal Log", owners: [user.localId] });
      const log2 = await createTestLifeLog(ctx, cleanup, { name: "Work Log", owners: [user.localId] });
      const log3 = await createTestLifeLog(ctx, cleanup, { name: "Fitness Log", owners: [user.localId] });

      // All three exist
      const [snap1, snap2, snap3] = await Promise.all([
        getDoc(log1),
        getDoc(log2),
        getDoc(log3),
      ]);

      expect(snap1.exists()).toBe(true);
      expect(snap2.exists()).toBe(true);
      expect(snap3.exists()).toBe(true);
    });

    it("should handle log with empty owners array (orphaned log)", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      // Create log directly without cleanup tracking (will become orphaned)
      const logRef = doc(collection(ctx.db, "lifeLogs"));
      await setDoc(logRef, {
        name: "Orphaned Log",
        owners: [user.localId],
        created: Timestamp.now(),
        updated: Timestamp.now(),
      });

      // Remove all owners (creates orphaned log)
      await updateDoc(logRef, { owners: [] });

      let logSnap = await getDoc(logRef);
      expect(logSnap.data()?.owners).toEqual([]);

      // User can still READ (rules allow any auth user)
      expect(logSnap.exists()).toBe(true);

      // But user cannot DELETE (not an owner)
      await expect(deleteDoc(logRef)).rejects.toThrow();

      // Cannot re-add self as owner either (rules require being owner to update)
      await expect(updateDoc(logRef, { owners: [user.localId] })).rejects.toThrow();

      // Log remains orphaned - in production would need admin cleanup
    });
  });

  describe("Duration Calculation Edge Cases", () => {
    it("should handle inconsistent duration vs start/end times", async () => {
      const user = await createUserWithoutSignIn(ctx);
      await signInAsUser(ctx, user);

      const logRef = await createTestLifeLog(ctx, cleanup, { owners: [user.localId] });

      // Start and end are 1 hour apart but duration says 5 hours
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 3600000); // 1 hour later

      const entryRef = await createTestEntry(ctx, logRef.id, cleanup, {
        type: "work",
        startTime: Timestamp.fromDate(startTime),
        endTime: Timestamp.fromDate(endTime),
        duration: 300, // Claims 5 hours (300 minutes)
        notes: "Duration doesn't match",
      });

      const entrySnap = await getDoc(entryRef);
      // Firestore stores what we tell it - no validation
      expect(entrySnap.data()?.duration).toBe(300);

      // Actual difference is ~60 minutes
      const actualDiff =
        (entrySnap.data()?.endTime.toMillis() -
          entrySnap.data()?.startTime.toMillis()) /
        60000;
      expect(Math.round(actualDiff)).toBe(60);
    });
  });
});
