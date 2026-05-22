/**
 * PocketBase implementation of LifeBackend.
 *
 * Writes route through the optimistic wrapper. Event subscription uses wpb so
 * optimistic mutations fan to the right log.
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

function eventFromRecord(r: RecordModel): LifeEvent {
  // `entries` should be an array post-migration; coerce defensively so a
  // half-deployed env or a malformed seed row can't crash the UI.
  const rawEntries = Array.isArray(r.entries) ? r.entries : [];
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

  const labels = (r.labels && typeof r.labels === "object" && !Array.isArray(r.labels))
    ? (r.labels as Record<string, string>)
    : undefined;

  return {
    id: r.id,
    log: r.log,
    subjectId: r.subject_id || "",
    timestamp: new Date(r.timestamp),
    endTime: r.end_time ? new Date(r.end_time) : undefined,
    entries,
    labels,
    createdBy: r.created_by || "",
    created: r.created,
    updated: r.updated,
  };
}

export class PocketBaseLifeBackend implements LifeBackend {
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase) {
    this.wpb = wpb;
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
    let cancelled = false;
    const eventsMap = new Map<string, LifeEvent>();

    const emit = () => {
      if (!cancelled) onEvents(Array.from(eventsMap.values()));
    };

    // wpb.subscribe with a filter auto-loads matching records, seeds the
    // optimistic queue, and delivers each as a "create" event before
    // forwarding live updates. We defer the first emit until subscribe()
    // resolves so consumers see one batched onEvents instead of N.
    let initialDone = false;
    let unsub: (() => void) | undefined;
    this.wpb.collection("life_events").subscribe("*", (e) => {
      if (cancelled || e.record.log !== logId) return;
      if (e.action === "delete") {
        eventsMap.delete(e.record.id);
      } else {
        eventsMap.set(e.record.id, eventFromRecord(e.record));
      }
      if (initialDone) emit();
    }, {
      filter: this.pb().filter("log = {:logId}", { logId }),
      local: (r) => r.log === logId,
    }).then((fn) => {
      unsub = fn;
      if (!cancelled) {
        initialDone = true;
        emit();
      }
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }
}
