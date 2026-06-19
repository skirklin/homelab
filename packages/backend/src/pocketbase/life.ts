/**
 * PocketBase implementation of LifeBackend.
 *
 * Writes route through the optimistic wrapper. Event subscription rides on
 * the PBMirror — a single filter-only-wildcard slice on `life_events` with
 * a predicate keyed to the log id. The mirror's queue overlay surfaces
 * optimistic creates immediately, with synchronous-teardown handles that
 * absorb every cancel-before-resolve.
 *
 * Schema reference: migration 20260522_221157_life_event_unified_shape.js.
 * Rows have `entries` (json[]), `labels` (json|null), `end_time` (date|null);
 * the old free-form `data` column was dropped in the same migration.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type {
  LifeBackend,
  AddTrackableInput,
  UpdateTrackablePatch,
  AddGoalInput,
  UpdateGoalPatch,
  AddViewInput,
  UpdateViewPatch,
  AddNotificationInput,
  UpdateNotificationPatch,
} from "../interfaces/life";
import type { LifeLog, LifeEvent, LifeEntry, LifeManifest } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../wrapped-pb/ids";
import { defaultLifeManifest } from "../life-manifest-default";
import {
  emptyManifest,
  addTrackable as addTrackableOp,
  updateTrackable as updateTrackableOp,
  removeTrackable as removeTrackableOp,
  reorderTrackables as reorderTrackablesOp,
} from "../life-manifest-ops";
import {
  addGoal as addGoalOp,
  updateGoal as updateGoalOp,
  removeGoal as removeGoalOp,
  reorderGoals as reorderGoalsOp,
} from "../life-goal-ops";
import {
  addView as addViewOp,
  updateView as updateViewOp,
  removeView as removeViewOp,
  reorderViews as reorderViewsOp,
  addNotification as addNotificationOp,
  updateNotification as updateNotificationOp,
  removeNotification as removeNotificationOp,
  reorderNotifications as reorderNotificationsOp,
} from "../life-view-ops";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

/**
 * Coerce a PB `manifest` JSON column into a `LifeManifest` or null. The PB JS
 * SDK returns parsed JSON for this column; we still validate the shape so a
 * legacy/garbage row surfaces as null rather than crashing a consumer. P2 will
 * read this; until then the app keeps rendering from hardcoded TRACKABLES, so
 * a null here is harmless.
 */
function manifestFromRecord(raw: unknown): LifeManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.trackables)) return null;
  const out: LifeManifest = { trackables: m.trackables as LifeManifest["trackables"] };
  // `goals` is the optional thin interpretive layer; carry it through verbatim
  // when present (legacy manifests omit it). The pure ops validate on write.
  if (Array.isArray(m.goals)) out.goals = m.goals as LifeManifest["goals"];
  // `views` / `notifications` (Unified Capture, Phase B1) carry through
  // verbatim. An explicit `[]` is meaningful (it means "no views/notifications"
  // — distinct from `undefined` → the DEFAULT_* fallback), so we preserve the
  // empty array rather than coercing it to undefined.
  if (Array.isArray(m.views)) out.views = m.views as LifeManifest["views"];
  if (Array.isArray(m.notifications))
    out.notifications = m.notifications as LifeManifest["notifications"];
  return out;
}

function logFromRecord(r: RecordModel): LifeLog {
  return {
    id: r.id,
    sampleSchedule: r.sample_schedule || null,
    manifest: manifestFromRecord(r.manifest),
    // Coerce defensively — pre-migration rows surface as undefined for a
    // brief window before 20260522_221130 runs on a given environment.
    randomSamplingEnabled: !!r.random_sampling_enabled,
    created: r.created,
    updated: r.updated,
  };
}

function eventFromRecord(r: RecordModel | RawRecord): LifeEvent {
  // `entries` should be an array post-migration; coerce defensively so a
  // half-deployed env or a malformed seed row can't crash the UI.
  const x = r as Record<string, unknown>;
  const rawEntries = Array.isArray(x.entries) ? x.entries : [];
  const entries: LifeEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    if (e.type === "text" && typeof e.value === "string") {
      entries.push({ name: e.name, type: "text", value: e.value });
    } else if (e.type === "number" && typeof e.value === "number" && typeof e.unit === "string") {
      const out: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") out.scale = e.scale;
      entries.push(out);
    } else if (e.type === "bool" && typeof e.value === "boolean") {
      entries.push({ name: e.name, type: "bool", value: e.value });
    }
  }

  const labels = (x.labels && typeof x.labels === "object" && !Array.isArray(x.labels))
    ? (x.labels as Record<string, string>)
    : undefined;

  return {
    id: r.id,
    log: x.log as string,
    subjectId: (x.subject_id as string) || "",
    timestamp: new Date(x.timestamp as string),
    endTime: x.end_time ? new Date(x.end_time as string) : undefined,
    entries,
    labels,
    createdBy: (x.created_by as string) || "",
    created: x.created as string,
    updated: x.updated as string,
  };
}

export class PocketBaseLifeBackend implements LifeBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
  }

  async getOrCreateLog(userId: string): Promise<LifeLog> {
    // life_logs is single-owner (migration 0028) and each user has at most
    // one row, so a filter on the back-pointer is the source of truth. No
    // forward pointer on users to keep in sync — 0029 dropped it.
    const owned = await this.pb().collection("life_logs").getList(1, 1, {
      filter: this.pb().filter("owner = {:uid}", { uid: userId }),
      sort: "created",
    });
    if (owned.items.length > 0) {
      return logFromRecord(owned.items[0]);
    }

    // Seed the minimal type-demo starter manifest on CREATE only. Existing
    // logs (post-backfill) keep their own manifest — this path never runs for
    // them because the owner-filter above returns first.
    const id = newId();
    const r = await this.wpb.collection("life_logs").create({
      id,
      name: "Life Log",
      owner: userId,
      manifest: defaultLifeManifest(),
    });
    return logFromRecord(r as RecordModel);
  }

  async clearSampleSchedule(logId: string): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, { sample_schedule: null });
  }

  async setRandomSamplingEnabled(logId: string, enabled: boolean): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, {
      random_sampling_enabled: enabled,
    });
  }

  async mutateManifest(
    logId: string,
    mutate: (current: LifeManifest) => LifeManifest,
  ): Promise<LifeManifest> {
    // Read-modify-write the single `manifest` JSON column. We read the freshest
    // manifest from the plain client (a config read doesn't need the wpb queue
    // overlay), apply the pure mutation, and write the whole manifest back. The
    // pure ops only ever touch the targeted trackable, so the rest of the
    // manifest is preserved byte-for-byte. A null/garbage column reads as an
    // empty manifest so `add` works on a fresh log.
    const rec = await this.pb().collection("life_logs").getOne(logId);
    const current = manifestFromRecord(rec.manifest) ?? emptyManifest();
    const next = mutate(current);
    await this.wpb.collection("life_logs").update(logId, { manifest: next });
    return next;
  }

  addTrackable(logId: string, input: AddTrackableInput): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => addTrackableOp(cur, input));
  }

  updateTrackable(
    logId: string,
    trackableId: string,
    patch: UpdateTrackablePatch,
  ): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => updateTrackableOp(cur, trackableId, patch));
  }

  removeTrackable(logId: string, trackableId: string): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => removeTrackableOp(cur, trackableId));
  }

  reorderTrackables(logId: string, orderedIds: string[]): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => reorderTrackablesOp(cur, orderedIds));
  }

  addGoal(logId: string, input: AddGoalInput): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => addGoalOp(cur, input));
  }

  updateGoal(logId: string, goalId: string, patch: UpdateGoalPatch): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => updateGoalOp(cur, goalId, patch));
  }

  removeGoal(logId: string, goalId: string): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => removeGoalOp(cur, goalId));
  }

  reorderGoals(logId: string, orderedIds: string[]): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => reorderGoalsOp(cur, orderedIds));
  }

  addView(logId: string, input: AddViewInput): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => addViewOp(cur, input));
  }

  updateView(logId: string, viewId: string, patch: UpdateViewPatch): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => updateViewOp(cur, viewId, patch));
  }

  removeView(logId: string, viewId: string): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => removeViewOp(cur, viewId));
  }

  reorderViews(logId: string, orderedIds: string[]): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => reorderViewsOp(cur, orderedIds));
  }

  addNotification(logId: string, input: AddNotificationInput): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => addNotificationOp(cur, input));
  }

  updateNotification(
    logId: string,
    notificationId: string,
    patch: UpdateNotificationPatch,
  ): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => updateNotificationOp(cur, notificationId, patch));
  }

  removeNotification(logId: string, notificationId: string): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => removeNotificationOp(cur, notificationId));
  }

  reorderNotifications(logId: string, orderedIds: string[]): Promise<LifeManifest> {
    return this.mutateManifest(logId, (cur) => reorderNotificationsOp(cur, orderedIds));
  }

  async addEvent(
    logId: string,
    subjectId: string,
    entries: LifeEntry[],
    userId: string,
    options?: { timestamp?: Date; endTime?: Date; labels?: Record<string, string> },
  ): Promise<string> {
    // Invariant: refuse empty-payload writes. An event with no entries[] is
    // indistinguishable from a real log in aggregates and pollutes any
    // downstream observer ("8 sleep events" when only 3 had values). See
    // apps/life/DATA_COLLECTION.md F1 for the May 13–27 audit that
    // motivated this. Callers that legitimately want to record a
    // dismissed-prompt analytics event should use a distinct subject_id
    // (e.g. `<subject>_prompt_dismissed`) rather than poisoning the
    // canonical trackable.
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(
        `addEvent rejected: empty entries[] for subject_id="${subjectId}". ` +
          `Provide at least one entry, or use a distinct subject_id for ` +
          `dismissed-prompt analytics.`,
      );
    }
    const id = newId();
    const payload: Record<string, unknown> = {
      id,
      log: logId,
      subject_id: subjectId,
      timestamp: (options?.timestamp ?? new Date()).toISOString(),
      created_by: userId,
      entries,
    };
    if (options?.endTime) payload.end_time = options.endTime.toISOString();
    if (options?.labels && Object.keys(options.labels).length > 0) payload.labels = options.labels;
    // Per-record requestKey so a burst of life_events creates (e.g. a session
    // wizard writing N per-item events with Promise.all) doesn't auto-cancel.
    // PocketBase's JS SDK keys in-flight requests by method+path by DEFAULT, so
    // N concurrent creates to the SAME collection share one key and all-but-one
    // get auto-cancelled ("The request was autocancelled"). A unique key per
    // event id makes the writes independent. The id is locally generated and
    // unique per event, so collisions are impossible.
    await this.wpb.collection("life_events").create(payload, { requestKey: `life-event-${id}` });
    return id;
  }

  async updateEvent(
    eventId: string,
    updates: {
      timestamp?: Date;
      endTime?: Date | null;
      entries?: LifeEntry[];
      labels?: Record<string, string> | null;
    },
  ): Promise<void> {
    // Mirror the addEvent invariant (F1): when entries is *being set* on
    // update, it must not be empty or a non-array. A missing `entries`
    // key is fine — that just means this update isn't touching entries
    // (e.g. a timestamp-only backfill correction). Only reject when the
    // caller is explicitly writing `entries: []`, which re-introduces
    // exactly the polluting rows the original audit motivated. See
    // apps/life/DATA_COLLECTION.md F1.
    if (updates.entries !== undefined && (!Array.isArray(updates.entries) || updates.entries.length === 0)) {
      throw new Error(
        `updateEvent rejected: entries must be a non-empty array when set ` +
          `(eventId="${eventId}"). Omit the field to leave it unchanged, ` +
          `or delete the event if it should no longer exist.`,
      );
    }
    const patch: Record<string, unknown> = {};
    if (updates.timestamp) patch.timestamp = updates.timestamp.toISOString();
    if (updates.endTime !== undefined) {
      patch.end_time = updates.endTime ? updates.endTime.toISOString() : null;
    }
    if (updates.entries !== undefined) patch.entries = updates.entries;
    if (updates.labels !== undefined) patch.labels = updates.labels;
    if (Object.keys(patch).length === 0) return;
    await this.wpb.collection("life_events").update(eventId, patch);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.wpb.collection("life_events").delete(eventId);
  }

  subscribeToEvents(logId: string, onEvents: (events: LifeEvent[]) => void): Unsubscribe {
    // Filter-only wildcard slice on life_events keyed to this log. The
    // mirror's queue overlay surfaces optimistic creates synchronously and
    // delivers full state on every change; no per-record bookkeeping or
    // initialDone latch needed.
    const handle = this.mirror.watch(
      {
        collection: "life_events",
        topic: "*",
        filter: this.pb().filter("log = {:logId}", { logId }),
        predicate: (r) => r.log === logId,
      },
      (records) => {
        onEvents(records.map(eventFromRecord));
      },
    );
    return () => handle.unsubscribe();
  }
}
