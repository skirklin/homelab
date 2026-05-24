/**
 * Life tracker backend interface.
 *
 * Covers: log management and events. The trackable / session manifest is
 * code-defined in the frontend (apps/life/.../manifest.ts); no DB-driven
 * config.
 */
import type { Unsubscribe } from "../types/common";
import type { LifeLog, LifeEvent, LifeEntry } from "../types/life";

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

  /**
   * Opt the log in or out of random-sample push notifications. Gates the
   * per-5-minute cron in `services/api/src/lib/notifications/life.ts` — when
   * disabled, no schedule is generated and no pushes fire.
   */
  setRandomSamplingEnabled(logId: string, enabled: boolean): Promise<void>;

  // --- Events ---

  /**
   * Create a life event under the given log.
   *
   * `entries` carries every named typed value captured at this moment.
   * `labels` are categorical dimensions (`source`, `category`, etc. — see
   * the LifeEvent docstring for the convention list).
   *
   * Returns the new event's id.
   */
  addEvent(
    logId: string,
    subjectId: string,
    entries: LifeEntry[],
    userId: string,
    options?: { timestamp?: Date; endTime?: Date; labels?: Record<string, string> },
  ): Promise<string>;

  /**
   * Patch an existing event. Each provided field is set wholesale (no
   * merging of `entries`/`labels` arrays — pass the complete new value).
   */
  updateEvent(
    eventId: string,
    updates: {
      timestamp?: Date;
      endTime?: Date | null;
      entries?: LifeEntry[];
      labels?: Record<string, string> | null;
    },
  ): Promise<void>;

  deleteEvent(eventId: string): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to all events for a life log.
   * Callback receives full current state on initial load and after every change.
   */
  subscribeToEvents(
    logId: string,
    onEvents: (events: LifeEvent[]) => void,
  ): Unsubscribe;
}
