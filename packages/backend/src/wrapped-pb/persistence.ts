/**
 * IndexedDB persistence for the optimistic mutation queue.
 *
 * Mutations are written to IDB before firing to PB so that a reload mid-flight
 * can replay them on next session. Replay is safe-by-design because:
 *  - Creates carry client-supplied IDs → PB treats duplicate id as 409 we swallow
 *  - Updates are last-write-wins patches → idempotent on retry
 *  - Deletes are idempotent (404 on retry = "already gone" = success)
 */
import { getDb, MUTATIONS_STORE } from "../cache/storage";
import type { PendingMutation } from "./queue";

export interface PersistedMutation extends PendingMutation {
  /** Origin tab/session — used by leader-election to avoid double-replay. */
  origin: string;
}

export async function persistMutation(m: PersistedMutation): Promise<void> {
  try {
    const db = await getDb();
    await db.put(MUTATIONS_STORE, m);
  } catch {
    // Persistence failures are non-fatal — the in-memory queue still works.
  }
}

export async function unpersistMutation(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(MUTATIONS_STORE, id);
  } catch {
    // ignore
  }
}

export async function loadAllMutations(): Promise<PersistedMutation[]> {
  try {
    const db = await getDb();
    const all = (await db.getAll(MUTATIONS_STORE)) as PersistedMutation[];
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function clearAllMutations(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(MUTATIONS_STORE);
  } catch {
    // ignore
  }
}
