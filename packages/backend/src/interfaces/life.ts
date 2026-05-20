/**
 * Life tracker backend interface.
 *
 * Covers: log management and entries/events. Widget config lives in the
 * frontend as a code-defined manifest — no DB-driven config.
 */
import type { Unsubscribe } from "../types/common";
import type { LifeLog, LifeEntry } from "../types/life";

export interface LifeBackend {
  // --- Log ---

  /** Get or create the user's life log. Returns log ID and runtime state. */
  getOrCreateLog(userId: string): Promise<LifeLog>;
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
