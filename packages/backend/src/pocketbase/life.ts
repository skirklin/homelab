/**
 * PocketBase implementation of LifeBackend.
 *
 * Writes route through the optimistic wrapper. Entries subscription uses
 * wpb so optimistic mutations fan to the right log.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import type { WrappedPocketBase } from "../wrapped-pb";

function logFromRecord(r: RecordModel): LifeLog {
  return {
    id: r.id,
    sampleSchedule: r.sample_schedule || null,
    // Coerce defensively — pre-0033 rows surface as undefined for a brief
    // window before the migration runs on a given environment.
    randomSamplingEnabled: !!r.random_sampling_enabled,
    morningReminderTime: r.morning_reminder_time || null,
    eveningReminderTime: r.evening_reminder_time || null,
    weeklyReminderTime: r.weekly_reminder_time || null,
    lastWeeklyReminderSent: r.last_weekly_reminder_sent || null,
    created: r.created,
    updated: r.updated,
  };
}

function entryFromRecord(r: RecordModel): LifeEntry {
  return {
    id: r.id,
    log: r.log,
    widgetId: r.subject_id || "",
    timestamp: new Date(r.timestamp),
    createdBy: r.created_by || "",
    data: r.data || {},
    notes: r.notes || undefined,
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

  async addEntry(logId: string, widgetId: string, data: Record<string, unknown>, userId: string, options?: { timestamp?: Date; notes?: string }): Promise<string> {
    const eventData: Record<string, unknown> = { ...data };
    if (options?.notes) {
      eventData.notes = options.notes;
    }
    const id = newId();
    await this.wpb.collection("life_events").create({
      id,
      log: logId,
      subject_id: widgetId,
      timestamp: (options?.timestamp ?? new Date()).toISOString(),
      created_by: userId,
      data: eventData,
    });
    return id;
  }

  async updateEntry(entryId: string, updates: { timestamp?: Date; data?: Record<string, unknown>; notes?: string }): Promise<void> {
    const record = await this.pb().collection("life_events").getOne(entryId);
    const patch: Record<string, unknown> = {};
    if (updates.timestamp) patch.timestamp = updates.timestamp.toISOString();
    if (updates.data) {
      const merged = { ...(record.data || {}), ...updates.data };
      if (updates.notes !== undefined) merged.notes = updates.notes;
      patch.data = merged;
    } else if (updates.notes !== undefined) {
      // Merge notes into existing data
      patch.data = { ...(record.data || {}), notes: updates.notes };
    }
    await this.wpb.collection("life_events").update(entryId, patch);
  }

  async deleteEntry(entryId: string): Promise<void> {
    await this.wpb.collection("life_events").delete(entryId);
  }

  subscribeToEntries(logId: string, onEntries: (entries: LifeEntry[]) => void): Unsubscribe {
    let cancelled = false;
    const entriesMap = new Map<string, LifeEntry>();

    const emit = () => {
      if (!cancelled) onEntries(Array.from(entriesMap.values()));
    };

    // wpb.subscribe with a filter auto-loads matching records, seeds the
    // optimistic queue, and delivers each as a "create" event before
    // forwarding live updates. We defer the first emit until subscribe()
    // resolves so consumers see one batched onEntries instead of N.
    let initialDone = false;
    let unsub: (() => void) | undefined;
    this.wpb.collection("life_events").subscribe("*", (e) => {
      if (cancelled || e.record.log !== logId) return;
      if (e.action === "delete") {
        entriesMap.delete(e.record.id);
      } else {
        entriesMap.set(e.record.id, entryFromRecord(e.record));
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
