/**
 * Test utilities for e2e tests with Firebase emulators
 */
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  setDoc,
  addDoc,
  getDocs,
  deleteDoc,
  Timestamp,
  type Firestore,
  type DocumentReference,
} from "firebase/firestore";

const TEST_PROJECT_ID = "recipe-box-335721";
const AUTH_EMULATOR_HOST = "http://localhost:9099";

// Unique app name per test file to avoid conflicts
let appCounter = 0;

/**
 * Represents a user created via the emulator REST API (without signing in)
 */
export interface EmulatorUser {
  localId: string;  // This is the uid
  email: string;
  password: string;
}

export interface TestContext {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  testUser: User | null;
  /** Additional users created without signing in */
  additionalUsers: EmulatorUser[];
}

/**
 * Initialize Firebase for testing with emulators
 */
export async function initTestFirebase(): Promise<TestContext> {
  const appName = `test-app-${Date.now()}-${appCounter++}`;

  const app = initializeApp(
    {
      apiKey: "test-api-key",
      projectId: TEST_PROJECT_ID,
      authDomain: "localhost",
    },
    appName
  );

  const auth = getAuth(app);
  const db = getFirestore(app);

  // Connect to emulators
  try {
    connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  } catch {
    // Already connected
  }

  try {
    connectFirestoreEmulator(db, "localhost", 8180);
  } catch {
    // Already connected
  }

  return { app, auth, db, testUser: null, additionalUsers: [] };
}

/**
 * Create and sign in a test user
 */
export async function createTestUser(
  ctx: TestContext,
  email?: string,
  password?: string
): Promise<User> {
  const testEmail = email || `test-${Date.now()}@example.com`;
  const testPassword = password || "testpassword123";

  try {
    const cred = await createUserWithEmailAndPassword(ctx.auth, testEmail, testPassword);
    ctx.testUser = cred.user;
    return cred.user;
  } catch (error: any) {
    if (error.code === "auth/email-already-in-use") {
      const cred = await signInWithEmailAndPassword(ctx.auth, testEmail, testPassword);
      ctx.testUser = cred.user;
      return cred.user;
    }
    throw error;
  }
}

/**
 * Create a user via the Auth Emulator REST API WITHOUT signing in.
 * This is useful for multi-user testing where you need additional users
 * but don't want to change the current auth state.
 *
 * @returns EmulatorUser with uid (localId), email, and password
 */
export async function createUserWithoutSignIn(
  ctx: TestContext,
  email?: string,
  password?: string
): Promise<EmulatorUser> {
  const userEmail = email || `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const userPassword = password || "testpassword123";

  // Use the Auth Emulator REST API to create user without affecting auth state
  const response = await fetch(
    `${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: userEmail,
        password: userPassword,
        returnSecureToken: false, // Don't need tokens since we're not signing in
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create user: ${error}`);
  }

  const data = await response.json();
  const user: EmulatorUser = {
    localId: data.localId,
    email: userEmail,
    password: userPassword,
  };

  ctx.additionalUsers.push(user);
  return user;
}

/**
 * Sign in as a specific user (useful for switching between users in multi-user tests)
 */
export async function signInAsUser(
  ctx: TestContext,
  user: EmulatorUser
): Promise<User> {
  const cred = await signInWithEmailAndPassword(ctx.auth, user.email, user.password);
  return cred.user;
}

/**
 * Sign out and clean up the test user
 */
export async function cleanupTestUser(ctx: TestContext): Promise<void> {
  if (ctx.testUser) {
    await signOut(ctx.auth);
    ctx.testUser = null;
  }
}

/**
 * Clean up a Firestore collection (for test isolation)
 */
export async function clearCollection(db: Firestore, path: string): Promise<void> {
  const colRef = collection(db, path);
  const snapshot = await getDocs(colRef);
  await Promise.all(snapshot.docs.map((doc) => deleteDoc(doc.ref)));
}

/**
 * Clean up and delete the test app
 */
export async function cleanupTestFirebase(ctx: TestContext): Promise<void> {
  await cleanupTestUser(ctx);
  await deleteApp(ctx.app);
}

/**
 * Wait for a condition to be true (useful for real-time updates)
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// =============================================================================
// Test Fixtures - Factory functions for creating test data
// =============================================================================

/** Generate a unique ID for test documents */
export function testId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Track documents created during a test for automatic cleanup */
export class TestCleanup {
  private refs: DocumentReference[] = [];

  track<T extends DocumentReference>(ref: T): T {
    this.refs.push(ref);
    return ref;
  }

  async cleanup(): Promise<void> {
    // Delete in reverse order (children before parents)
    for (const ref of this.refs.reverse()) {
      try {
        await deleteDoc(ref);
      } catch {
        // Ignore errors (doc may already be deleted)
      }
    }
    this.refs = [];
  }
}

// =============================================================================
// Groceries Test Helpers
// =============================================================================

export interface CreateListOptions {
  name?: string;
  owners?: string[];
  categoryDefs?: Array<{ id: string; name: string; color: string }>;
}

export async function createTestList(
  ctx: TestContext,
  cleanup: TestCleanup,
  options: CreateListOptions = {}
): Promise<DocumentReference> {
  const listId = testId("list");
  const listRef = doc(ctx.db, "lists", listId);

  await setDoc(listRef, {
    name: options.name ?? "Test List",
    owners: options.owners ?? [ctx.auth.currentUser!.uid],
    categoryDefs: options.categoryDefs ?? [],
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  cleanup.track(listRef);
  return listRef;
}

export interface CreateItemOptions {
  name?: string;
  categoryId?: string;
  checked?: boolean;
}

export async function createTestItem(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  options: CreateItemOptions = {}
): Promise<DocumentReference> {
  const itemRef = doc(collection(ctx.db, "lists", listId, "items"));

  await setDoc(itemRef, {
    name: options.name ?? "Test Item",
    categoryId: options.categoryId ?? "misc",
    checked: options.checked ?? false,
    addedBy: ctx.auth.currentUser!.uid,
    addedAt: Timestamp.now(),
  });

  cleanup.track(itemRef);
  return itemRef;
}

// =============================================================================
// Upkeep Test Helpers
// =============================================================================

export interface CreateTaskListOptions {
  name?: string;
  owners?: string[];
  roomDefs?: Array<{ id: string; name: string; color: string }>;
}

export async function createTestTaskList(
  ctx: TestContext,
  cleanup: TestCleanup,
  options: CreateTaskListOptions = {}
): Promise<DocumentReference> {
  const listId = testId("tasklist");
  const listRef = doc(ctx.db, "taskLists", listId);

  await setDoc(listRef, {
    name: options.name ?? "Test Task List",
    owners: options.owners ?? [ctx.auth.currentUser!.uid],
    roomDefs: options.roomDefs ?? [],
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  cleanup.track(listRef);
  return listRef;
}

export interface CreateTaskOptions {
  name?: string;
  roomId?: string;
  frequency?: { value: number; unit: string };
  lastCompleted?: Timestamp | null;
}

export async function createTestTask(
  ctx: TestContext,
  listId: string,
  cleanup: TestCleanup,
  options: CreateTaskOptions = {}
): Promise<DocumentReference> {
  const taskRef = await addDoc(collection(ctx.db, "taskLists", listId, "tasks"), {
    name: options.name ?? "Test Task",
    roomId: options.roomId ?? "general",
    frequency: options.frequency ?? { value: 1, unit: "days" },
    lastCompleted: options.lastCompleted ?? null,
    createdBy: ctx.auth.currentUser!.uid,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  cleanup.track(taskRef);
  return taskRef;
}

// =============================================================================
// Life Tracker Test Helpers
// =============================================================================

export interface CreateLifeLogOptions {
  name?: string;
  owners?: string[];
}

export async function createTestLifeLog(
  ctx: TestContext,
  cleanup: TestCleanup,
  options: CreateLifeLogOptions = {}
): Promise<DocumentReference> {
  const logRef = doc(collection(ctx.db, "lifeLogs"));

  await setDoc(logRef, {
    name: options.name ?? "Test Life Log",
    owners: options.owners ?? [ctx.auth.currentUser!.uid],
    created: Timestamp.now(),
    updated: Timestamp.now(),
  });

  cleanup.track(logRef);
  return logRef;
}

export interface CreateEntryOptions {
  type?: string;
  startTime?: Timestamp;
  endTime?: Timestamp | null;
  duration?: number | null;
  notes?: string;
}

export async function createTestEntry(
  ctx: TestContext,
  logId: string,
  cleanup: TestCleanup,
  options: CreateEntryOptions = {}
): Promise<DocumentReference> {
  const now = Timestamp.now();
  const entryRef = await addDoc(collection(ctx.db, "lifeLogs", logId, "entries"), {
    type: options.type ?? "work",
    startTime: options.startTime ?? now,
    endTime: options.endTime ?? now,
    duration: options.duration ?? 60,
    notes: options.notes ?? "",
    createdBy: ctx.auth.currentUser!.uid,
    createdAt: now,
  });

  cleanup.track(entryRef);
  return entryRef;
}

// =============================================================================
// Recipes Test Helpers
// =============================================================================

export interface CreateBoxOptions {
  name?: string;
  owners?: string[];
  visibility?: string;
}

export async function createTestBox(
  ctx: TestContext,
  cleanup: TestCleanup,
  options: CreateBoxOptions = {}
): Promise<DocumentReference> {
  const boxId = testId("box");
  const boxRef = doc(ctx.db, "boxes", boxId);
  const now = Timestamp.now();

  await setDoc(boxRef, {
    data: { name: options.name ?? "Test Box" },
    owners: options.owners ?? [ctx.auth.currentUser!.uid],
    visibility: options.visibility ?? "private",
    creator: ctx.auth.currentUser!.uid,
    created: now,
    updated: now,
    lastUpdatedBy: ctx.auth.currentUser!.uid,
  });

  cleanup.track(boxRef);
  return boxRef;
}

export interface CreateRecipeOptions {
  name?: string;
  description?: string;
  owners?: string[];
  visibility?: string;
  ingredients?: string[];
  instructions?: string[];
}

export async function createTestRecipe(
  ctx: TestContext,
  boxId: string,
  cleanup: TestCleanup,
  options: CreateRecipeOptions = {}
): Promise<DocumentReference> {
  const recipeRef = doc(collection(ctx.db, "boxes", boxId, "recipes"));
  const now = Timestamp.now();

  await setDoc(recipeRef, {
    data: {
      "@type": "Recipe",
      name: options.name ?? "Test Recipe",
      description: options.description ?? "A test recipe",
      recipeIngredient: options.ingredients ?? ["1 cup flour", "2 eggs"],
      recipeInstructions: (options.instructions ?? ["Mix ingredients", "Bake"]).map(
        (text, i) => ({ "@type": "HowToStep", position: i + 1, text })
      ),
    },
    owners: options.owners ?? [ctx.auth.currentUser!.uid],
    visibility: options.visibility ?? "private",
    creator: ctx.auth.currentUser!.uid,
    created: now,
    updated: now,
    lastUpdatedBy: ctx.auth.currentUser!.uid,
    enrichmentStatus: "needed",
  });

  cleanup.track(recipeRef);
  return recipeRef;
}

/**
 * Create a recipes user document with boxes array
 */
export async function createTestRecipesUser(
  ctx: TestContext,
  cleanup: TestCleanup,
  boxIds: string[] = []
): Promise<DocumentReference> {
  const userRef = doc(ctx.db, "users", ctx.auth.currentUser!.uid);
  const now = Timestamp.now();

  await setDoc(userRef, {
    name: ctx.auth.currentUser!.displayName ?? "Test User",
    visibility: "private",
    boxes: boxIds.map((id) => doc(ctx.db, "boxes", id)),
    lastSeen: now,
    newSeen: now,
    cookingModeSeen: false,
    lastSeenUpdateVersion: 0,
  });

  cleanup.track(userRef);
  return userRef;
}

/**
 * Add a box to a user's boxes array
 */
export async function addBoxToUser(
  ctx: TestContext,
  userId: string,
  boxId: string
): Promise<void> {
  const userRef = doc(ctx.db, "users", userId);
  const { arrayUnion, updateDoc } = await import("firebase/firestore");
  await updateDoc(userRef, {
    boxes: arrayUnion(doc(ctx.db, "boxes", boxId)),
  });
}

// =============================================================================
// Multi-user Test Helper
// =============================================================================

/**
 * Create a user and optionally sign in as them
 * Returns a function to restore the original user
 */
export async function withUser(
  ctx: TestContext,
  options: { signIn?: boolean } = { signIn: true }
): Promise<{ user: EmulatorUser; restore: () => Promise<void> }> {
  const previousUser = ctx.auth.currentUser;
  const user = await createUserWithoutSignIn(ctx);

  if (options.signIn) {
    await signInAsUser(ctx, user);
  }

  return {
    user,
    restore: async () => {
      if (previousUser) {
        // Can't easily restore - tests should manage their own user state
        // This is a limitation of the Firebase client SDK
      }
    },
  };
}
