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
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeEvent, LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

function logFromRecord(r: RecordModel): LifeLog {
  return {
    id: r.id,
    sampleSchedule: r.sample_schedule || null,
    // Coerce defensively — pre-migration rows surface as undefined for a
    // brief window before 20260522_221130 runs on a given environment.
    randomSamplingEnabled: !!r.random_sampling_enabled,
    morningReminderTime: r.morning_reminder_time || null,
    eveningReminderTime: r.evening_reminder_time || null,
    weeklyReminderTime: r.weekly_reminder_time || null,
    lastWeeklyReminderSent: r.last_weekly_reminder_sent || null,
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

    const id = newId();
    const r = await this.wpb.collection("life_logs").create({
      id,
      name: "Life Log",
      owner: userId,
    });
    return logFromRecord(r as RecordModel);
  }

  async clearSampleSchedule(logId: string): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, { sample_schedule: null });
  }

  async updateReminderTimes(
    logId: string,
    times: { morning?: string | null; evening?: string | null; weekly?: string | null },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(times, "morning")) {
      patch.morning_reminder_time = times.morning ?? "";
    }
    if (Object.prototype.hasOwnProperty.call(times, "evening")) {
      patch.evening_reminder_time = times.evening ?? "";
    }
    if (Object.prototype.hasOwnProperty.call(times, "weekly")) {
      patch.weekly_reminder_time = times.weekly ?? "";
    }
    if (Object.keys(patch).length === 0) return;
    await this.wpb.collection("life_logs").update(logId, patch);
  }

  async setRandomSamplingEnabled(logId: string, enabled: boolean): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, {
      random_sampling_enabled: enabled,
    });
  }

  async addEvent(
    logId: string,
    subjectId: string,
    entries: LifeEntry[],
    userId: string,
    options?: { timestamp?: Date; endTime?: Date; labels?: Record<string, string> },
  ): Promise<string> {
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
    await this.wpb.collection("life_events").create(payload);
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
