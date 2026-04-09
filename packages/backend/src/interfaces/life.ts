/**
 * Life tracker backend interface.
 *
 * Covers: log management, manifest (widget config), entries/events.
 */
import type { Unsubscribe } from "../types/common";
import type { LifeLog, LifeManifest, LifeEntry } from "../types/life";

export interface LifeBackend {
  // --- Log ---

  /** Get or create the user's life log. Returns log ID and data. */
  getOrCreateLog(userId: string): Promise<LifeLog>;
  updateManifest(logId: string, manifest: LifeManifest): Promise<void>;
  clearSampleSchedule(logId: string): Promise<void>;

  // --- Entries ---

  addEntry(logId: string, widgetId: string, data: Record<string, unknown>, userId: string, options?: { timestamp?: Date; notes?: string }): Promise<string>;
  updateEntry(entryId: string, updates: { timestamp?: Date; data?: Record<string, unknown>; notes?: string }): Promise<void>;
  deleteEntry(entryId: string): Promise<void>;
  addSampleResponse(logId: string, responses: Record<string, unknown>, userId: string): Promise<string>;

  // --- Subscriptions ---

  /**
   * Subscribe to all entries for a life log.
   * Callback receives full current state on initial load and after every change.
   */
  subscribeToEntries(
    logId: string,
    onEntries: (entries: LifeEntry[]) => void,
  ): Unsubscribe;
}
