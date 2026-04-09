/**
 * PocketBase implementation of TravelBackend.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { TravelBackend } from "../interfaces/travel";
import type { TravelLog, Trip, Activity, Itinerary, ItineraryDay, ChecklistTemplate } from "../types/travel";
import type { Unsubscribe } from "../types/common";

function logFromRecord(r: RecordModel): TravelLog {
  return {
    id: r.id,
    name: r.name || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    checklists: r.checklists || [],
  };
}

function tripFromRecord(r: RecordModel): Trip {
  return {
    id: r.id, log: r.log, name: r.name || "", destination: r.destination || "",
    startDate: r.start_date || "", endDate: r.end_date || "", notes: r.notes || "",
    flagged: !!r.flagged_for_review, flagComment: r.review_comment || "",
    checklistDone: r.checklist_done || {},
    status: r.status, region: r.region, source_refs: r.source_refs,
  };
}

function activityFromRecord(r: RecordModel): Activity {
  return {
    id: r.id, log: r.log, trip: r.trip_id || undefined, name: r.name || "",
    location: r.location || "", lat: r.lat, lng: r.lng, placeId: r.place_id,
    notes: r.notes || "", rating: r.rating, tags: r.tags || [],
    category: r.category || "", costNotes: r.cost_notes || "",
    durationEstimate: r.duration_estimate || "", confirmationCode: r.confirmation_code || "",
  };
}

function itineraryFromRecord(r: RecordModel): Itinerary {
  return {
    id: r.id, log: r.log, trip: r.trip_id, name: r.name || "",
    isActive: r.is_active ?? true, days: r.days || [],
    created: r.created, updated: r.updated,
  };
}

export class PocketBaseTravelBackend implements TravelBackend {
  constructor(private pb: () => PocketBase) {}

  async getOrCreateLog(userId: string): Promise<string> {
    const user = await this.pb().collection("users").getOne(userId);
    const slugs: Record<string, string> = user.travel_slugs || {};
    const firstId = Object.values(slugs)[0];
    if (firstId) {
      try { await this.pb().collection("travel_logs").getOne(firstId); return firstId; } catch {}
    }
    const log = await this.pb().collection("travel_logs").create({
      name: "My Travel Log", owners: [userId],
    });
    const newSlugs = { ...slugs, default: log.id };
    await this.pb().collection("users").update(userId, { travel_slugs: newSlugs });
    return log.id;
  }

  async updateLogChecklists(logId: string, checklists: ChecklistTemplate[]): Promise<void> {
    await this.pb().collection("travel_logs").update(logId, { checklists });
  }

  async addTrip(logId: string, trip: Omit<Trip, "id" | "log">): Promise<string> {
    const r = await this.pb().collection("travel_trips").create({ log: logId, ...this.tripData(trip) });
    return r.id;
  }

  async updateTrip(tripId: string, updates: Partial<Omit<Trip, "id" | "log">>): Promise<void> {
    await this.pb().collection("travel_trips").update(tripId, this.tripData(updates));
  }

  async deleteTrip(tripId: string): Promise<void> {
    await this.pb().collection("travel_trips").delete(tripId);
  }

  async flagTrip(tripId: string, flagged: boolean, comment?: string): Promise<void> {
    await this.pb().collection("travel_trips").update(tripId, { flagged_for_review: flagged, review_comment: comment || "" });
  }

  async toggleChecklistItem(tripId: string, itemId: string, done: boolean): Promise<void> {
    const trip = await this.pb().collection("travel_trips").getOne(tripId);
    const checklistDone = { ...(trip.checklist_done || {}), [itemId]: done };
    await this.pb().collection("travel_trips").update(tripId, { checklist_done: checklistDone });
  }

  async addActivity(logId: string, activity: Omit<Activity, "id" | "log">): Promise<string> {
    const r = await this.pb().collection("travel_activities").create({ log: logId, ...this.activityData(activity) });
    return r.id;
  }

  async updateActivity(activityId: string, updates: Partial<Omit<Activity, "id" | "log">>): Promise<void> {
    await this.pb().collection("travel_activities").update(activityId, this.activityData(updates));
  }

  async deleteActivity(activityId: string): Promise<void> {
    await this.pb().collection("travel_activities").delete(activityId);
  }

  async addItinerary(logId: string, tripId: string, itinerary: Omit<Itinerary, "id" | "log" | "trip">): Promise<string> {
    const r = await this.pb().collection("travel_itineraries").create({
      log: logId, trip_id: tripId, name: itinerary.name, days: itinerary.days || [],
    });
    return r.id;
  }

  async updateItinerary(itineraryId: string, updates: Partial<Omit<Itinerary, "id" | "log" | "trip">>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.days !== undefined) data.days = updates.days;
    await this.pb().collection("travel_itineraries").update(itineraryId, data);
  }

  async setItineraryDays(itineraryId: string, days: ItineraryDay[]): Promise<void> {
    await this.pb().collection("travel_itineraries").update(itineraryId, { days });
  }

  async deleteItinerary(itineraryId: string): Promise<void> {
    await this.pb().collection("travel_itineraries").delete(itineraryId);
  }

  subscribeToLog(
    logId: string,
    handlers: {
      onLog: (log: TravelLog) => void;
      onTrips: (trips: Trip[]) => void;
      onActivities: (activities: Activity[]) => void;
      onItineraries: (itineraries: Itinerary[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const tripsMap = new Map<string, Trip>();
    const activitiesMap = new Map<string, Activity>();
    const itinerariesMap = new Map<string, Itinerary>();

    // Log metadata
    this.sub("travel_logs", logId, () => cancelled, unsubs, {
      onData: (r) => handlers.onLog(logFromRecord(r)),
      onDelete: () => handlers.onDeleted?.(),
    });

    // Trips
    this.subCol("travel_trips", () => cancelled, unsubs, {
      filter: `log = "${logId}"`, belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) tripsMap.set(r.id, tripFromRecord(r)); handlers.onTrips(Array.from(tripsMap.values())); },
      onChange: (a, r) => { if (a === "delete") tripsMap.delete(r.id); else tripsMap.set(r.id, tripFromRecord(r)); handlers.onTrips(Array.from(tripsMap.values())); },
    });

    // Activities
    this.subCol("travel_activities", () => cancelled, unsubs, {
      filter: `log = "${logId}"`, belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) activitiesMap.set(r.id, activityFromRecord(r)); handlers.onActivities(Array.from(activitiesMap.values())); },
      onChange: (a, r) => { if (a === "delete") activitiesMap.delete(r.id); else activitiesMap.set(r.id, activityFromRecord(r)); handlers.onActivities(Array.from(activitiesMap.values())); },
    });

    // Itineraries
    this.subCol("travel_itineraries", () => cancelled, unsubs, {
      filter: `log = "${logId}"`, belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) itinerariesMap.set(r.id, itineraryFromRecord(r)); handlers.onItineraries(Array.from(itinerariesMap.values())); },
      onChange: (a, r) => { if (a === "delete") itinerariesMap.delete(r.id); else itinerariesMap.set(r.id, itineraryFromRecord(r)); handlers.onItineraries(Array.from(itinerariesMap.values())); },
    });

    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }

  private tripData(t: Partial<Omit<Trip, "id" | "log">>): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (t.name !== undefined) d.name = t.name;
    if (t.destination !== undefined) d.destination = t.destination;
    if (t.startDate !== undefined) d.start_date = t.startDate;
    if (t.endDate !== undefined) d.end_date = t.endDate;
    if (t.notes !== undefined) d.notes = t.notes;
    if (t.flagged !== undefined) d.flagged_for_review = t.flagged;
    if (t.flagComment !== undefined) d.review_comment = t.flagComment;
    if (t.checklistDone !== undefined) d.checklist_done = t.checklistDone;
    // Pass through extra fields (status, region, source_refs, etc.)
    const mapped = new Set(["id", "log", "name", "destination", "startDate", "endDate", "notes", "flagged", "flagComment", "checklistDone"]);
    for (const [k, v] of Object.entries(t)) {
      if (!mapped.has(k) && v !== undefined) d[k] = v;
    }
    return d;
  }

  private activityData(a: Partial<Omit<Activity, "id" | "log">>): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (a.trip !== undefined) d.trip_id = a.trip;
    if (a.name !== undefined) d.name = a.name;
    if (a.location !== undefined) d.location = a.location;
    if (a.lat !== undefined) d.lat = a.lat;
    if (a.lng !== undefined) d.lng = a.lng;
    if (a.placeId !== undefined) d.place_id = a.placeId;
    if (a.notes !== undefined) d.notes = a.notes;
    if (a.rating !== undefined) d.rating = a.rating;
    if (a.tags !== undefined) d.tags = a.tags;
    // Pass through extra fields (category, cost_notes, duration_estimate, etc.)
    const mapped = new Set(["id", "log", "trip", "name", "location", "lat", "lng", "placeId", "notes", "rating", "tags"]);
    for (const [k, v] of Object.entries(a)) {
      if (!mapped.has(k) && v !== undefined && !(k in d)) d[k] = v;
    }
    return d;
  }

  private sub(col: string, id: string, cancelled: () => boolean, unsubs: Array<() => void>, cb: { onData: (r: RecordModel) => void; onDelete?: () => void }) {
    this.pb().collection(col).getOne(id, { $autoCancel: false }).then((r) => { if (!cancelled()) cb.onData(r); }).catch(() => {});
    this.pb().collection(col).subscribe(id, (e) => { if (cancelled()) return; if (e.action === "delete") cb.onDelete?.(); else cb.onData(e.record); }).then((unsub) => unsubs.push(unsub));
  }

  private subCol(col: string, cancelled: () => boolean, unsubs: Array<() => void>, opts: { filter: string; belongsTo: (r: RecordModel) => boolean; onInitial: (rs: RecordModel[]) => void; onChange: (a: string, r: RecordModel) => void }) {
    this.pb().collection(col).getFullList({ filter: opts.filter, $autoCancel: false }).then((rs) => { if (!cancelled()) opts.onInitial(rs); }).catch(() => { if (!cancelled()) opts.onInitial([]); });
    this.pb().collection(col).subscribe("*", (e) => { if (cancelled() || !opts.belongsTo(e.record)) return; opts.onChange(e.action, e.record); }).then((unsub) => unsubs.push(unsub));
  }
}
