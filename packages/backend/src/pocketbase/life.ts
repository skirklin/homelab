/**
 * PocketBase implementation of LifeBackend.
 *
 * Writes route through the optimistic wrapper. Entries subscription uses
 * wpb so optimistic mutations fan to the right log.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeManifest, LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

function logFromRecord(r: RecordModel): LifeLog {
  return {
    id: r.id,
    manifest: r.manifest || { widgets: [] },
    sampleSchedule: r.sample_schedule || null,
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

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
  }

  async getOrCreateLog(userId: string): Promise<LifeLog> {
    const user = await this.pb().collection("users").getOne(userId);
    const logId = user.life_log_id;

    if (logId) {
      try {
        const r = await this.pb().collection("life_logs").getOne(logId);
        return logFromRecord(r);
      } catch {
        // Log was deleted, fall through to create
      }
    }

    const id = newId();
    const r = await this.wpb.collection("life_logs").create({
      id,
      name: "Life Log",
      owners: [userId],
      manifest: { widgets: [] },
    });
    await this.wpb.collection("users").update(userId, { life_log_id: id });
    return logFromRecord(r as RecordModel);
  }

  async updateManifest(logId: string, manifest: LifeManifest): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, { manifest });
  }

  async clearSampleSchedule(logId: string): Promise<void> {
    await this.wpb.collection("life_logs").update(logId, { sample_schedule: null });
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

  async addSampleResponse(logId: string, responses: Record<string, unknown>, userId: string): Promise<string> {
    const id = newId();
    await this.wpb.collection("life_events").create({
      id,
      log: logId,
      subject_id: "__sample__",
      timestamp: new Date().toISOString(),
      created_by: userId,
      data: { ...responses, source: "sample" },
    });
    return id;
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
