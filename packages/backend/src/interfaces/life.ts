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

  /**
   * Set or clear morning/evening/weekly reminder times for a log. Each value
   * is either a "HH:MM" 24h string or null to disable that reminder. Omitted
   * keys are left untouched.
   */
  updateReminderTimes(
    logId: string,
    times: { morning?: string | null; evening?: string | null; weekly?: string | null },
  ): Promise<void>;

  // --- Entries ---

  addEntry(logId: string, widgetId: string, data: Record<string, unknown>, userId: string, options?: { timestamp?: Date; notes?: string }): Promise<string>;
  updateEntry(entryId: string, updates: { timestamp?: Date; data?: Record<string, unknown>; notes?: string }): Promise<void>;
  deleteEntry(entryId: string): Promise<void>;

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
