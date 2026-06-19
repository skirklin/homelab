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
  TrackableShape,
  TemplateRef,
  LifeGoalScope,
  LifeGoalKind,
  LifeGoalMetric,
  LifeViewItem,
  LifeNotifyStrategy,
} from "../types/life";

/** Goal-definition creation input (see LifeGoal + life-goal-ops validation). */
export interface AddGoalInput {
  id: string;
  label: string;
  scope: LifeGoalScope;
  kind: LifeGoalKind;
  metric: LifeGoalMetric;
  target: number;
  unit?: string;
  period: "day" | "week";
  hidden?: boolean;
}

/** Goal patch (id/scope/kind/metric are immutable; only these are editable). */
export interface UpdateGoalPatch {
  label?: string;
  target?: number;
  unit?: string;
  period?: "day" | "week";
  hidden?: boolean;
}

/** View-definition creation input (see LifeView + life-view-ops validation). */
export interface AddViewInput {
  id: string;
  title: string;
  greeting?: string;
  icon?: string;
  render?: "guided" | "inline";
  items: LifeViewItem[];
}

/** View patch (id is immutable; everything else is editable). */
export interface UpdateViewPatch {
  title?: string;
  greeting?: string | null;
  icon?: string | null;
  render?: "guided" | "inline" | null;
  items?: LifeViewItem[];
}

/** Notification-definition creation input (see LifeNotification + life-view-ops). */
export interface AddNotificationInput {
  id: string;
  target: string;
  strategy: LifeNotifyStrategy;
  enabled?: boolean;
}

/** Notification patch (id + strategy.kind are immutable). */
export interface UpdateNotificationPatch {
  target?: string;
  strategy?: LifeNotifyStrategy;
  enabled?: boolean;
}

/** Vocab-row creation input (see LifeManifestTrackable). */
export interface AddTrackableInput {
  id: string;
  label: string;
  shape: TrackableShape;
  group?: string;
  hidden?: boolean;
  defaultUnit?: string;
  defaultAmount?: number;
  defaultDuration?: number;
  ratingLabel?: string;
  pinned?: QuickPayload[];
  /** View-render metadata (Phase-B consumers; round-trips through here). */
  prompt?: string;
  hint?: string;
  refs?: TemplateRef[];
}

/** Vocab-row patch (id + shape are immutable; null clears nullable hints). */
export interface UpdateTrackablePatch {
  label?: string;
  group?: string | null;
  hidden?: boolean;
  defaultUnit?: string | null;
  defaultAmount?: number | null;
  defaultDuration?: number | null;
  ratingLabel?: string | null;
  pinned?: QuickPayload[];
  /** View-render metadata (Phase-B); null/"" clears. */
  prompt?: string | null;
  hint?: string | null;
  refs?: TemplateRef[] | null;
}

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

  // --- Trackable manifest (P4) ---

  /**
   * Read-modify-write the log's `manifest` JSON column with `mutate`, which
   * receives the current manifest (empty `{trackables:[]}` if the column is
   * null/garbage) and returns the next one. Every trackable mutation below is
   * built on this: it reads the freshest manifest, applies a PURE op from
   * `life-manifest-ops`, and writes the whole manifest back, touching ONLY the
   * targeted trackable and never clobbering the rest.
   * The pure op throws `ManifestError` on invalid input; this method does not
   * catch it. Returns the persisted manifest.
   */
  mutateManifest(logId: string, mutate: (current: LifeManifest) => LifeManifest): Promise<LifeManifest>;

  /** Add a new vocab row. Validates id slug/uniqueness, shape, defaults, pins. */
  addTrackable(logId: string, input: AddTrackableInput): Promise<LifeManifest>;

  /**
   * Patch an existing trackable's label/group/hidden/defaults/ratingLabel/
   * pinned. Rejects any `id` or `shape` change (history join key + entries[]
   * contract). Pass only the keys to change; null clears nullable hints.
   */
  updateTrackable(
    logId: string,
    trackableId: string,
    patch: UpdateTrackablePatch,
  ): Promise<LifeManifest>;

  /**
   * Remove a trackable from the manifest. Manifest-only — NEVER deletes any
   * `life_events`; events with that subject_id persist and re-link if a
   * trackable with the same id is re-added.
   */
  removeTrackable(logId: string, trackableId: string): Promise<LifeManifest>;

  /** Reorder trackables. `orderedIds` must be a permutation of the current ids. */
  reorderTrackables(logId: string, orderedIds: string[]): Promise<LifeManifest>;

  // --- Goals (thin interpretive layer over events; manifest-only) ---

  /**
   * Add a goal to the log's `manifest.goals[]`. Validates the full shape +
   * id uniqueness (see life-goal-ops). Manifest-only — never touches events.
   */
  addGoal(logId: string, input: AddGoalInput): Promise<LifeManifest>;

  /**
   * Patch a goal's label/target/unit/period/hidden. `id`, `scope`, `kind`, and
   * `metric` are IMMUTABLE (they define what the goal measures).
   */
  updateGoal(logId: string, goalId: string, patch: UpdateGoalPatch): Promise<LifeManifest>;

  /** Remove a goal from the manifest. Manifest-only — never touches events. */
  removeGoal(logId: string, goalId: string): Promise<LifeManifest>;

  /** Reorder goals. `orderedIds` must be a permutation of the current goal ids. */
  reorderGoals(logId: string, orderedIds: string[]): Promise<LifeManifest>;

  // --- Views (Unified Capture; manifest-only) ---

  /**
   * Add a view to the log's `manifest.views[]`. Validates the full shape + id
   * uniqueness (see life-view-ops). `id` is IMMUTABLE (it is written to
   * `life_events.labels.view`). Manifest-only — never touches events.
   */
  addView(logId: string, input: AddViewInput): Promise<LifeManifest>;

  /** Patch a view's title/greeting/icon/render/items. `id` is IMMUTABLE. */
  updateView(logId: string, viewId: string, patch: UpdateViewPatch): Promise<LifeManifest>;

  /** Remove a view from the manifest. Manifest-only — never touches events. */
  removeView(logId: string, viewId: string): Promise<LifeManifest>;

  /** Reorder views. `orderedIds` must be a permutation of the current view ids. */
  reorderViews(logId: string, orderedIds: string[]): Promise<LifeManifest>;

  // --- Notifications (Unified Capture; manifest-only) ---

  /**
   * Add a notification to the log's `manifest.notifications[]`. Validates the
   * full shape + id uniqueness (see life-view-ops). `id` is IMMUTABLE (it keys
   * `reminder_state`). Manifest-only — never touches events.
   */
  addNotification(logId: string, input: AddNotificationInput): Promise<LifeManifest>;

  /**
   * Patch a notification's target/strategy/enabled. `id` and `strategy.kind`
   * are IMMUTABLE (id keys reminder_state; kind decides how it fires).
   */
  updateNotification(
    logId: string,
    notificationId: string,
    patch: UpdateNotificationPatch,
  ): Promise<LifeManifest>;

  /** Remove a notification from the manifest. Manifest-only — never touches events. */
  removeNotification(logId: string, notificationId: string): Promise<LifeManifest>;

  /** Reorder notifications. `orderedIds` must be a permutation of current ids. */
  reorderNotifications(logId: string, orderedIds: string[]): Promise<LifeManifest>;

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
