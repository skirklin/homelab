/**
 * Supabase implementation of LifeBackend.
 *
 * Maps PB's life_logs + life_events to Postgres. Same subscription model
 * as shopping items: per-record map, full state emitted on each delta,
 * initial state loaded after the channel hits SUBSCRIBED.
 *
 * getOrCreateLog mirrors the PB recovery logic:
 *   1. If user_profiles.life_log_id is set and the log exists → return it
 *   2. Else, look for any owned life_log → adopt it, fix the pointer
 *   3. Else, create a new log + owner row + link in user_profiles
 *
 * No optimistic write layer yet — Phase 3 first cut.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeManifest, LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";

interface LogRow {
  id: string;
  name: string;
  manifest: LifeManifest | null;
  sample_schedule: unknown;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  log_id: string;
  subject_id: string;
  timestamp: string;
  created_by: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function logFromRow(r: LogRow): LifeLog {
  return {
    id: r.id,
    manifest: r.manifest ?? { widgets: [] },
    sampleSchedule: r.sample_schedule ?? null,
    created: r.created_at,
    updated: r.updated_at,
  };
}

function entryFromRow(r: EventRow): LifeEntry {
  const data = r.data ?? {};
  // PB version stored `notes` inside the data JSON; mirror that for parity.
  const { notes, ...rest } = data as Record<string, unknown>;
  return {
    id: r.id,
    log: r.log_id,
    widgetId: r.subject_id,
    timestamp: new Date(r.timestamp),
    createdBy: r.created_by ?? "",
    data: rest,
    notes: typeof notes === "string" && notes ? notes : undefined,
    created: r.created_at,
    updated: r.updated_at,
  };
}

export class SupabaseLifeBackend implements LifeBackend {
  constructor(private client: SupabaseClient) {}

  async getOrCreateLog(userId: string): Promise<LifeLog> {
    // 1. Try the recorded pointer on user_profiles.
    const { data: profile } = await this.client
      .from("user_profiles")
      .select("life_log_id")
      .eq("id", userId)
      .maybeSingle();
    const pointerLogId: string | null = profile?.life_log_id ?? null;

    if (pointerLogId) {
      const { data: log } = await this.client
        .from("life_logs")
        .select("*")
        .eq("id", pointerLogId)
        .maybeSingle();
      if (log) return logFromRow(log as LogRow);
      // pointer is stale; fall through to recovery
    }

    // 2. Recovery: look for any life_log this user owns.
    const { data: owned } = await this.client
      .from("life_log_owners")
      .select("log_id, life_logs!inner(*)")
      .eq("user_id", userId)
      .order("log_id", { ascending: true })
      .limit(1);
    if (owned && owned.length > 0) {
      const adopted = (owned[0] as unknown as { life_logs: LogRow }).life_logs;
      await this.upsertProfilePointer(userId, adopted.id);
      return logFromRow(adopted);
    }

    // 3. Create a fresh log.
    const { data: created, error: createErr } = await this.client
      .from("life_logs")
      .insert({ name: "Life Log", manifest: { widgets: [] } })
      .select("*")
      .single();
    if (createErr) throw createErr;
    const newLog = created as LogRow;

    const { error: ownerErr } = await this.client
      .from("life_log_owners")
      .insert({ log_id: newLog.id, user_id: userId });
    if (ownerErr) {
      // Best-effort cleanup so we don't leak an unowned log.
      await this.client.from("life_logs").delete().eq("id", newLog.id);
      throw ownerErr;
    }
    await this.upsertProfilePointer(userId, newLog.id);
    return logFromRow(newLog);
  }

  async updateManifest(logId: string, manifest: LifeManifest): Promise<void> {
    const { error } = await this.client
      .from("life_logs")
      .update({ manifest })
      .eq("id", logId);
    if (error) throw error;
  }

  async clearSampleSchedule(logId: string): Promise<void> {
    const { error } = await this.client
      .from("life_logs")
      .update({ sample_schedule: null })
      .eq("id", logId);
    if (error) throw error;
  }

  async addEntry(
    logId: string,
    widgetId: string,
    data: Record<string, unknown>,
    userId: string,
    options?: { timestamp?: Date; notes?: string },
  ): Promise<string> {
    // PB version stored `notes` inside data; keep the same shape for parity.
    const eventData: Record<string, unknown> = { ...data };
    if (options?.notes) eventData.notes = options.notes;

    const { data: row, error } = await this.client
      .from("life_events")
      .insert({
        log_id: logId,
        subject_id: widgetId,
        timestamp: (options?.timestamp ?? new Date()).toISOString(),
        created_by: userId,
        data: eventData,
      })
      .select("id")
      .single();
    if (error) throw error;
    return row.id;
  }

  async updateEntry(
    entryId: string,
    updates: { timestamp?: Date; data?: Record<string, unknown>; notes?: string },
  ): Promise<void> {
    // Read-modify-write on the data blob so we can merge.
    const { data: existing, error: readErr } = await this.client
      .from("life_events")
      .select("data")
      .eq("id", entryId)
      .single();
    if (readErr) throw readErr;
    const currentData = (existing.data as Record<string, unknown> | null) ?? {};

    const patch: Record<string, unknown> = {};
    if (updates.timestamp) patch.timestamp = updates.timestamp.toISOString();

    if (updates.data) {
      const merged = { ...currentData, ...updates.data };
      if (updates.notes !== undefined) merged.notes = updates.notes;
      patch.data = merged;
    } else if (updates.notes !== undefined) {
      patch.data = { ...currentData, notes: updates.notes };
    }

    if (Object.keys(patch).length === 0) return;

    const { error } = await this.client
      .from("life_events")
      .update(patch)
      .eq("id", entryId);
    if (error) throw error;
  }

  async deleteEntry(entryId: string): Promise<void> {
    const { error } = await this.client.from("life_events").delete().eq("id", entryId);
    if (error) throw error;
  }

  async addSampleResponse(
    logId: string,
    responses: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const { data, error } = await this.client
      .from("life_events")
      .insert({
        log_id: logId,
        subject_id: "__sample__",
        timestamp: new Date().toISOString(),
        created_by: userId,
        data: { ...responses, source: "sample" },
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  subscribeToEntries(logId: string, onEntries: (entries: LifeEntry[]) => void): Unsubscribe {
    let cancelled = false;
    const entriesMap = new Map<string, LifeEntry>();

    const emit = () => {
      if (!cancelled) onEntries(Array.from(entriesMap.values()));
    };

    const channel: RealtimeChannel = this.client
      .channel(`life-entries-${logId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "life_events",
          filter: `log_id=eq.${logId}`,
        },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<EventRow>;
            if (old.id) entriesMap.delete(old.id);
          } else {
            const row = payload.new as EventRow;
            entriesMap.set(row.id, entryFromRow(row));
          }
          emit();
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || cancelled) return;
        const { data, error } = await this.client
          .from("life_events")
          .select("*")
          .eq("log_id", logId);
        if (cancelled) return;
        entriesMap.clear();
        if (!error && data) {
          for (const row of data as EventRow[]) {
            entriesMap.set(row.id, entryFromRow(row));
          }
        }
        emit();
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(channel);
    };
  }

  // ---- helpers -----------------------------------------------------------

  private async upsertProfilePointer(userId: string, logId: string): Promise<void> {
    const { error } = await this.client
      .from("user_profiles")
      .upsert({ id: userId, life_log_id: logId }, { onConflict: "id" });
    if (error) throw error;
  }
}
