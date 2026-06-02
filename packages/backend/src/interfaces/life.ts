/**
 * Life tracker backend interface.
 *
 * Covers: log management and events. The trackable / session manifest is
 * code-defined in the frontend (apps/life/.../manifest.ts); no DB-driven
 * config.
 */
import type { Unsubscribe } from "../types/common";
import type {
  LifeLog,
  LifeEvent,
  LifeEntry,
  QuickPayload,
  LifeManifest,
  TypedField,
} from "../types/life";

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

  /**
   * Replace one trackable's `pinned[]` quick-action favorites in the log's
   * manifest. Read-modify-write of the single `manifest` JSON column: the
   * caller computes the complete new pin list (the per-trackable set is small),
   * and only that trackable's `pinned` is swapped — every other trackable and
   * field is left byte-for-byte intact. No-ops cleanly if the trackable isn't
   * in the manifest (it may have been removed). `pinned[]` is presentation
   * state, NOT a history join key, so it is freely mutable.
   */
  setTrackablePins(logId: string, trackableId: string, pins: QuickPayload[]): Promise<void>;

  // --- Trackable manifest (P4) ---

  /**
   * Read-modify-write the log's `manifest` JSON column with `mutate`, which
   * receives the current manifest (empty `{trackables:[]}` if the column is
   * null/garbage) and returns the next one. Every trackable mutation below is
   * built on this: it reads the freshest manifest, applies a PURE op from
   * `life-manifest-ops`, and writes the whole manifest back, touching ONLY the
   * targeted trackable and never clobbering the rest (mirrors `setTrackablePins`).
   * The pure op throws `ManifestError` on invalid input; this method does not
   * catch it. Returns the persisted manifest.
   */
  mutateManifest(logId: string, mutate: (current: LifeManifest) => LifeManifest): Promise<LifeManifest>;

  /** Add a new trackable. Validates id slug/uniqueness, fields, and pins. */
  addTrackable(
    logId: string,
    input: { id: string; label: string; group?: string; hidden?: boolean; fields: TypedField[]; pinned?: QuickPayload[] },
  ): Promise<LifeManifest>;

  /**
   * Patch an existing trackable's label/group/hidden/fields/pinned. Rejects any
   * `id` change and any rename/removal/retype of an existing `field.key` (the
   * history join keys); adding new fields is allowed. Pass only the fields to change.
   */
  updateTrackable(
    logId: string,
    trackableId: string,
    patch: { label?: string; group?: string | null; hidden?: boolean; fields?: TypedField[]; pinned?: QuickPayload[] },
  ): Promise<LifeManifest>;

  /**
   * Remove a trackable from the manifest. Manifest-only — NEVER deletes any
   * `life_events`; events with that subject_id persist and re-link if a
   * trackable with the same id is re-added.
   */
  removeTrackable(logId: string, trackableId: string): Promise<LifeManifest>;

  /** Reorder trackables. `orderedIds` must be a permutation of the current ids. */
  reorderTrackables(logId: string, orderedIds: string[]): Promise<LifeManifest>;

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
