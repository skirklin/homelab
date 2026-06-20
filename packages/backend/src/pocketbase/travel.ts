/**
 * PocketBase implementation of TravelBackend.
 *
 * Writes route through the optimistic wrapper. subscribeToLog rides on
 * the PBMirror with five slices (log record + trips/activities/itineraries/
 * notes filtered by log) — the mirror handles cancel-before-resolve,
 * ref-counts the SSE channel per collection, and delivers full state per
 * slice. `getOrCreateLog` keeps its server lookup since the user-slug
 * resolution isn't expressible against the local cache.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { TravelBackend } from "../interfaces/travel";
import type { TravelLog, Trip, Activity, Itinerary, ItineraryDay, ActivitySlot, TravelNote } from "../types/travel";
import type { LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../wrapped-pb/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

function logFromRecord(r: RecordModel | RawRecord): TravelLog {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    name: (x.name as string) || "",
    owners: Array.isArray(x.owners) ? (x.owners as string[]) : [],
    created: x.created as string,
    updated: x.updated as string,
  };
}

function tripFromRecord(r: RecordModel | RawRecord): Trip {
  const x = r as Record<string, unknown>;
  // Mostly mechanical snake_case→camelCase, but two fields are true RENAMES
  // (different words, not just recasing): the `flagged_for_review` column maps
  // to `flagged`, and `review_comment` maps to `flagComment`. A server-side
  // grep for `flagged` / `flagComment` will NOT find the PB column names.
  return {
    id: r.id, log: x.log as string, name: (x.name as string) || "", destination: (x.destination as string) || "",
    startDate: (x.start_date as string) || "", endDate: (x.end_date as string) || "",
    flagged: !!x.flagged_for_review, flagComment: (x.review_comment as string) || "",
    status: x.status as Trip["status"], region: x.region as Trip["region"], sourceRefs: x.source_refs as Trip["sourceRefs"],
    created: x.created as string, updated: x.updated as string,
  };
}

function activityFromRecord(r: RecordModel | RawRecord): Activity {
  const x = r as Record<string, unknown>;
  return {
    id: r.id, log: x.log as string, trip: (x.trip_id as string) || undefined, name: (x.name as string) || "",
    location: (x.location as string) || "", lat: x.lat as Activity["lat"], lng: x.lng as Activity["lng"], placeId: x.place_id as Activity["placeId"],
    description: (x.description as string) || "", rating: x.rating as Activity["rating"], tags: (x.tags as string[]) || [],
    category: (x.category as string) || "", costNotes: (x.cost_notes as string) || "",
    durationEstimate: (x.duration_estimate as string) || "", walkMiles: typeof x.walk_miles === "number" ? x.walk_miles : undefined,
    elevationGainFeet: typeof x.elevation_gain_feet === "number" ? x.elevation_gain_feet : undefined,
    difficulty: (x.difficulty as Activity["difficulty"]) || undefined,
    confirmationCode: (x.confirmation_code as string) || "",
    details: x.details as Activity["details"], setting: x.setting as Activity["setting"],
    ratingCount: x.rating_count as Activity["ratingCount"],
    photoRef: x.photo_ref as Activity["photoRef"],
    flightInfo: (x.flight_info as Activity["flightInfo"]) || undefined,
    experiencedAt: (x.experienced_at as string) || undefined,
    created: x.created as string, updated: x.updated as string,
  };
}

/**
 * Defensive parser for the travel_notes.entries column. Identical shape to
 * recipe_events / life_events — kept local rather than imported so the travel
 * mapper has no cross-backend coupling.
 */
function entriesFromRecord(r: RecordModel | RawRecord): LifeEntry[] {
  const x = r as Record<string, unknown>;
  const raw = Array.isArray(x.entries) ? x.entries : [];
  const out: LifeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    if (e.type === "text" && typeof e.value === "string") {
      out.push({ name: e.name, type: "text", value: e.value });
    } else if (e.type === "number" && typeof e.value === "number" && typeof e.unit === "string") {
      const entry: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") entry.scale = e.scale;
      out.push(entry);
    } else if (e.type === "bool" && typeof e.value === "boolean") {
      out.push({ name: e.name, type: "bool", value: e.value });
    }
  }
  return out;
}

function noteFromRecord(r: RecordModel | RawRecord): TravelNote {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    log: x.log as string,
    subjectType: (x.subject_type as string) || "",
    subjectId: (x.subject_id as string) || "",
    createdBy: (x.created_by as string) || "",
    entries: entriesFromRecord(r),
    created: x.created as string,
    updated: x.updated as string,
  };
}

/** Newest-first by `created` — matches cooking-log behavior. */
function notesNewestFirst(notes: TravelNote[]): TravelNote[] {
  return notes.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
}

/**
 * Read a slot/flight back-compatibly: surface the legacy `notes` key as
 * `dayNote` until the backfill renames it on disk. `startTime` is read as-is
 * (canonical or legacy free-form); the UI normalizes display via parseSlotTime.
 */
function slotFromRaw(raw: unknown): ActivitySlot {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slot: ActivitySlot = { activityId: (s.activityId as string) || "" };
  if (typeof s.startTime === "string" && s.startTime) slot.startTime = s.startTime;
  const dayNote = (typeof s.dayNote === "string" ? s.dayNote : undefined)
    ?? (typeof s.notes === "string" ? s.notes : undefined);
  if (dayNote) slot.dayNote = dayNote;
  return slot;
}

function dayFromRaw(raw: unknown): ItineraryDay {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const day: ItineraryDay = {
    label: (d.label as string) || "",
    slots: Array.isArray(d.slots) ? d.slots.map(slotFromRaw) : [],
  };
  if (typeof d.date === "string" && d.date) day.date = d.date;
  if (typeof d.lodgingActivityId === "string") day.lodgingActivityId = d.lodgingActivityId;
  if (Array.isArray(d.flights)) day.flights = d.flights.map(slotFromRaw);
  return day;
}

function itineraryFromRecord(r: RecordModel | RawRecord): Itinerary {
  const x = r as Record<string, unknown>;
  return {
    id: r.id, log: x.log as string, trip: x.trip_id as string, name: (x.name as string) || "",
    isActive: (x.is_active as boolean) ?? true,
    days: Array.isArray(x.days) ? x.days.map(dayFromRaw) : [],
    created: x.created as string, updated: x.updated as string,
  };
}

export class PocketBaseTravelBackend implements TravelBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
  }

  async getOrCreateLog(userId: string): Promise<string> {
    const user = await this.pb().collection("users").getOne(userId);
    const slugs: Record<string, string> = user.travel_slugs || {};
    const firstId = Object.values(slugs)[0];
    if (firstId) {
      try {
        await this.pb().collection("travel_logs").getOne(firstId);
        return firstId;
      } catch (err: unknown) {
        // Only fall through on genuine 404 — transient errors must NOT
        // cause us to mint a duplicate log and orphan the user's data.
        const status = (err as { status?: number })?.status;
        if (status !== 404) throw err;
      }
    }

    // Before creating a new log, recover any log this user already owns.
    // Defense-in-depth against a corrupted travel_slugs pointer.
    const owned = await this.pb().collection("travel_logs").getList(1, 1, {
      filter: this.pb().filter("owners.id ?= {:uid}", { uid: userId }),
      sort: "created",
    });
    if (owned.items.length > 0) {
      const existing = owned.items[0];
      const newSlugs = { ...slugs };
      // Preserve whichever slug key pointed at the missing log; otherwise
      // add a "default" entry so the rest of the app can find it.
      let updated = false;
      for (const [k, v] of Object.entries(newSlugs)) {
        if (v === firstId) { newSlugs[k] = existing.id; updated = true; }
      }
      if (!updated) newSlugs.default = existing.id;
      await this.wpb.collection("users").update(userId, { travel_slugs: newSlugs });
      return existing.id;
    }

    const id = newId();
    await this.wpb.collection("travel_logs").create({
      id,
      name: "My Travel Log",
      owners: [userId],
    });
    const newSlugs = { ...slugs, default: id };
    await this.wpb.collection("users").update(userId, { travel_slugs: newSlugs });
    return id;
  }

  async addTrip(logId: string, trip: Omit<Trip, "id" | "log" | "created" | "updated">): Promise<string> {
    const id = newId();
    await this.wpb.collection("travel_trips").create({ id, log: logId, ...this.tripData(trip) });
    return id;
  }

  async updateTrip(tripId: string, updates: Partial<Omit<Trip, "id" | "log" | "created" | "updated">>): Promise<void> {
    await this.wpb.collection("travel_trips").update(tripId, this.tripData(updates));
  }

  async deleteTrip(tripId: string): Promise<void> {
    await this.wpb.collection("travel_trips").delete(tripId);
  }

  async flagTrip(tripId: string, flagged: boolean, comment?: string): Promise<void> {
    await this.wpb.collection("travel_trips").update(tripId, { flagged_for_review: flagged, review_comment: comment || "" });
  }

  async addActivity(logId: string, activity: Omit<Activity, "id" | "log" | "created" | "updated">): Promise<string> {
    const id = newId();
    await this.wpb.collection("travel_activities").create({ id, log: logId, ...this.activityData(activity) });
    return id;
  }

  async updateActivity(activityId: string, updates: Partial<Omit<Activity, "id" | "log" | "created" | "updated">>): Promise<void> {
    await this.wpb.collection("travel_activities").update(activityId, this.activityData(updates));
  }

  async deleteActivity(activityId: string): Promise<void> {
    await this.wpb.collection("travel_activities").delete(activityId);
  }

  async addItinerary(logId: string, tripId: string, itinerary: Omit<Itinerary, "id" | "log" | "trip" | "created" | "updated">): Promise<string> {
    const id = newId();
    await this.wpb.collection("travel_itineraries").create({
      id, log: logId, trip_id: tripId, name: itinerary.name, days: itinerary.days || [],
    });
    return id;
  }

  async updateItinerary(itineraryId: string, updates: Partial<Omit<Itinerary, "id" | "log" | "trip" | "created" | "updated">>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.days !== undefined) data.days = updates.days;
    await this.wpb.collection("travel_itineraries").update(itineraryId, data);
  }

  async setItineraryDays(itineraryId: string, days: ItineraryDay[]): Promise<void> {
    await this.wpb.collection("travel_itineraries").update(itineraryId, { days });
  }

  async deleteItinerary(itineraryId: string): Promise<void> {
    await this.wpb.collection("travel_itineraries").delete(itineraryId);
  }

  // --- Notes (per-user feedback) ---

  async getNotes(logId: string, subjectType: string, subjectId: string): Promise<TravelNote[]> {
    try {
      const records = await this.pb().collection("travel_notes").getFullList({
        filter: this.pb().filter(
          "log = {:logId} && subject_type = {:subjectType} && subject_id = {:subjectId}",
          { logId, subjectType, subjectId },
        ),
        sort: "-created",
      });
      // Sort newest-first defensively too, so the result is correctly ordered
      // independent of transport (the server `sort` is the fast path).
      return notesNewestFirst(records.map(noteFromRecord));
    } catch {
      return [];
    }
  }

  async addNote(
    logId: string,
    subjectType: string,
    subjectId: string,
    userId: string,
    entries: LifeEntry[],
  ): Promise<string> {
    const id = newId();
    // PB does NOT auto-stamp created_by — the create path must set it.
    await this.wpb.collection("travel_notes").create({
      id,
      log: logId,
      subject_type: subjectType,
      subject_id: subjectId,
      created_by: userId,
      entries,
    });
    return id;
  }

  async updateNote(noteId: string, entries: LifeEntry[]): Promise<void> {
    await this.wpb.collection("travel_notes").update(noteId, { entries });
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.wpb.collection("travel_notes").delete(noteId);
  }

  subscribeToLog(
    logId: string,
    handlers: {
      onLog: (log: TravelLog) => void;
      onTrips: (trips: Trip[]) => void;
      onActivities: (activities: Activity[]) => void;
      onItineraries: (itineraries: Itinerary[]) => void;
      onNotes: (notes: TravelNote[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    // Track first-observed-existing so an initial 404 on the log doesn't
    // misfire onDeleted (same pattern as shopping/upkeep).
    let logKnownExisted = false;

    const logFilter = this.pb().filter("log = {:logId}", { logId });
    const inLog = (r: RawRecord) => r.log === logId;

    const logHandle = this.mirror.watch(
      { collection: "travel_logs", topic: logId },
      (records) => {
        if (records.length === 0) {
          if (logKnownExisted) handlers.onDeleted?.();
          return;
        }
        logKnownExisted = true;
        handlers.onLog(logFromRecord(records[0]));
      },
    );

    const tripsHandle = this.mirror.watch(
      { collection: "travel_trips", topic: "*", filter: logFilter, predicate: inLog },
      (records) => handlers.onTrips(records.map(tripFromRecord)),
    );

    const activitiesHandle = this.mirror.watch(
      { collection: "travel_activities", topic: "*", filter: logFilter, predicate: inLog },
      (records) => handlers.onActivities(records.map(activityFromRecord)),
    );

    const itinerariesHandle = this.mirror.watch(
      { collection: "travel_itineraries", topic: "*", filter: logFilter, predicate: inLog },
      (records) => handlers.onItineraries(records.map(itineraryFromRecord)),
    );

    // Notes ride the log-level mirror so per-user feedback loads instantly
    // when the log opens, not on-demand per subject.
    const notesHandle = this.mirror.watch(
      { collection: "travel_notes", topic: "*", filter: logFilter, predicate: inLog },
      (records) => handlers.onNotes(notesNewestFirst(records.map(noteFromRecord))),
    );

    return () => {
      logHandle.unsubscribe();
      tripsHandle.unsubscribe();
      activitiesHandle.unsubscribe();
      itinerariesHandle.unsubscribe();
      notesHandle.unsubscribe();
    };
  }

  private tripData(t: Partial<Omit<Trip, "id" | "log" | "created" | "updated">>): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (t.name !== undefined) d.name = t.name;
    if (t.destination !== undefined) d.destination = t.destination;
    if (t.startDate !== undefined) d.start_date = t.startDate;
    if (t.endDate !== undefined) d.end_date = t.endDate;
    if (t.flagged !== undefined) d.flagged_for_review = t.flagged;
    if (t.flagComment !== undefined) d.review_comment = t.flagComment;
    if (t.sourceRefs !== undefined) d.source_refs = t.sourceRefs;
    // Pass through extra fields (status, region, etc.)
    const mapped = new Set(["id", "log", "name", "destination", "startDate", "endDate", "flagged", "flagComment", "sourceRefs", "created", "updated"]);
    for (const [k, v] of Object.entries(t)) {
      if (!mapped.has(k) && v !== undefined) d[k] = v;
    }
    return d;
  }

  private activityData(a: Partial<Omit<Activity, "id" | "log" | "created" | "updated">>): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (a.trip !== undefined) d.trip_id = a.trip;
    if (a.name !== undefined) d.name = a.name;
    if (a.location !== undefined) d.location = a.location;
    if (a.lat !== undefined) d.lat = a.lat;
    if (a.lng !== undefined) d.lng = a.lng;
    if (a.placeId !== undefined) d.place_id = a.placeId;
    if (a.description !== undefined) d.description = a.description;
    if (a.rating !== undefined) d.rating = a.rating;
    if (a.tags !== undefined) d.tags = a.tags;
    if (a.category !== undefined) d.category = a.category;
    if (a.costNotes !== undefined) d.cost_notes = a.costNotes;
    if (a.durationEstimate !== undefined) d.duration_estimate = a.durationEstimate;
    if (a.walkMiles !== undefined) d.walk_miles = a.walkMiles;
    if (a.elevationGainFeet !== undefined) d.elevation_gain_feet = a.elevationGainFeet;
    if (a.difficulty !== undefined) d.difficulty = a.difficulty;
    if (a.confirmationCode !== undefined) d.confirmation_code = a.confirmationCode;
    if (a.details !== undefined) d.details = a.details;
    if (a.setting !== undefined) d.setting = a.setting;
    if (a.ratingCount !== undefined) d.rating_count = a.ratingCount;
    if (a.photoRef !== undefined) d.photo_ref = a.photoRef;
    if (a.flightInfo !== undefined) d.flight_info = a.flightInfo;
    if (a.experiencedAt !== undefined) d.experienced_at = a.experiencedAt;
    return d;
  }

}
