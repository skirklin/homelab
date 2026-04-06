/**
 * Verification test - runs against BROKEN rules to confirm tests catch the bugs.
 * These tests SHOULD FAIL when run against the broken rules.
 *
 * Run with: npx vitest run verify-broken.test.ts
 */

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { readFileSync } from 'fs';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';

let testEnv: RulesTestEnvironment;

const USER_A = 'user-a-id';
const USER_B = 'user-b-id';

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'test-project-broken',
    firestore: {
      rules: readFileSync('./firestore-broken.rules', 'utf8'),
      host: 'localhost',
      port: 8180,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('Verify broken rules cause failures', () => {
  it('BROKEN: User B cannot read list metadata (should fail with broken rules)', async () => {
    const LIST_ID = 'test-list';

    // Setup: User A creates the list
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'lists', LIST_ID), {
        name: 'Family Groceries',
        owners: [USER_A],
      });
    });

    // With broken rules, this SHOULD FAIL (User B can't read without being owner)
    const userBDb = testEnv.authenticatedContext(USER_B).firestore();
    const listRef = doc(userBDb, 'lists', LIST_ID);

    // We expect this to FAIL with broken rules
    try {
      await getDoc(listRef);
      // If we get here, the read succeeded - broken rules are NOT in effect
      throw new Error('TEST SETUP ERROR: Read succeeded but should have failed with broken rules');
    } catch (e: any) {
      // Expected: permission denied
      expect(e.code).toBe('permission-denied');
    }
  });

  it('BROKEN: User B cannot add themselves to owners (should fail with broken rules)', async () => {
    const LIST_ID = 'test-list-2';

    // Setup: User A creates the list
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'lists', LIST_ID), {
        name: 'Family Groceries',
        owners: [USER_A],
      });
    });

    // With broken rules, this SHOULD FAIL (User B can't update without being owner)
    const userBDb = testEnv.authenticatedContext(USER_B).firestore();
    const listRef = doc(userBDb, 'lists', LIST_ID);

    // We expect this to FAIL with broken rules
    try {
      await updateDoc(listRef, { owners: arrayUnion(USER_B) });
      // If we get here, the update succeeded - broken rules are NOT in effect
      throw new Error('TEST SETUP ERROR: Update succeeded but should have failed with broken rules');
    } catch (e: any) {
      // Expected: permission denied
      expect(e.code).toBe('permission-denied');
    }
  });

  it('BROKEN: Upkeep - User B cannot read taskList metadata (should fail with broken rules)', async () => {
    const LIST_ID = 'test-tasklist';

    // Setup: User A creates the list
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'taskLists', LIST_ID), {
        name: 'Home Maintenance',
        owners: [USER_A],
      });
    });

    // With broken rules, this SHOULD FAIL
    const userBDb = testEnv.authenticatedContext(USER_B).firestore();
    const listRef = doc(userBDb, 'taskLists', LIST_ID);

    try {
      await getDoc(listRef);
      throw new Error('TEST SETUP ERROR: Read succeeded but should have failed with broken rules');
    } catch (e: any) {
      expect(e.code).toBe('permission-denied');
    }
  });

  it('BROKEN: Upkeep - User B cannot add themselves to owners (should fail with broken rules)', async () => {
    const LIST_ID = 'test-tasklist-2';

    // Setup: User A creates the list
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'taskLists', LIST_ID), {
        name: 'Home Maintenance',
        owners: [USER_A],
      });
    });

    // With broken rules, this SHOULD FAIL
    const userBDb = testEnv.authenticatedContext(USER_B).firestore();
    const listRef = doc(userBDb, 'taskLists', LIST_ID);

    try {
      await updateDoc(listRef, { owners: arrayUnion(USER_B) });
      throw new Error('TEST SETUP ERROR: Update succeeded but should have failed with broken rules');
    } catch (e: any) {
      expect(e.code).toBe('permission-denied');
    }
  });
});
