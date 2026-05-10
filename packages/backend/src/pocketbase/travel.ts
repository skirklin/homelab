/**
 * PocketBase implementation of TravelBackend.
 *
 * Writes route through the optimistic wrapper. Trip/activity/itinerary/day-entry
 * subscriptions use wpb so optimistic mutations fan to the right log. The two
 * read-then-write spots (`getOrCreateLog`, `upsertDayEntry`) keep their server
 * lookup since the filter shape (`trip = X && date = Y`) isn't expressible
 * against the local cache without v2 query-time filtering.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { TravelBackend } from "../interfaces/travel";
import type { TravelLog, Trip, Activity, ActivityVerdict, Itinerary, ItineraryDay, TripProposal, DayEntry } from "../types/travel";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

function logFromRecord(r: RecordModel): TravelLog {
  return {
    id: r.id,
    name: r.name || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    created: r.created,
    updated: r.updated,
  };
}

function tripFromRecord(r: RecordModel): Trip {
  return {
    id: r.id, log: r.log, name: r.name || "", destination: r.destination || "",
    startDate: r.start_date || "", endDate: r.end_date || "", notes: r.notes || "",
    flagged: !!r.flagged_for_review, flagComment: r.review_comment || "",
    status: r.status, region: r.region, sourceRefs: r.source_refs,
    created: r.created, updated: r.updated,
  };
}

function activityFromRecord(r: RecordModel): Activity {
  return {
    id: r.id, log: r.log, trip: r.trip_id || undefined, name: r.name || "",
    location: r.location || "", lat: r.lat, lng: r.lng, placeId: r.place_id,
    description: r.description || "", rating: r.rating, tags: r.tags || [],
    category: r.category || "", costNotes: r.cost_notes || "",
    durationEstimate: r.duration_estimate || "", walkMiles: typeof r.walk_miles === "number" ? r.walk_miles : undefined,
    elevationGainFeet: typeof r.elevation_gain_feet === "number" ? r.elevation_gain_feet : undefined,
    difficulty: r.difficulty || undefined,
    confirmationCode: r.confirmation_code || "",
    details: r.details, setting: r.setting,
    bookingReqs: r.booking_reqs, ratingCount: r.rating_count,
    photoRef: r.photo_ref,
    flightInfo: r.flight_info || undefined,
    verdict: (r.verdict as ActivityVerdict) || undefined,
    personalNotes: r.personal_notes || undefined,
    experiencedAt: r.experienced_at || undefined,
    created: r.created, updated: r.updated,
  };
}

function dayEntryFromRecord(r: RecordModel): DayEntry {
  return {
    id: r.id,
    log: r.log,
    trip: r.trip,
    date: r.date || "",
    text: r.text || "",
    highlight: r.highlight || undefined,
    mood: typeof r.mood === "number" ? r.mood : undefined,
    created: r.created,
    updated: r.updated,
  };
}

function proposalFromRecord(r: RecordModel): TripProposal {
  return {
    id: r.id,
    trip: r.trip,
    question: r.question || "",
    reasoning: r.reasoning || "",
    candidateIds: Array.isArray(r.candidate_ids) ? r.candidate_ids : [],
    claudePicks: Array.isArray(r.claude_picks) ? r.claude_picks : [],
    feedback: (r.feedback || {}) as TripProposal["feedback"],
    overallFeedback: r.overall_feedback || "",
    state: (r.state as "open" | "resolved") || "open",
    resolvedAt: r.resolved_at || undefined,
    userRespondedAt: r.user_responded_at || undefined,
    claudeLastSeenAt: r.claude_last_seen_at || undefined,
    created: r.created,
    updated: r.updated,
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
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
  }

  async getOrCreateLog(userId: string): Promise<string> {
    const user = await this.pb().collection("users").getOne(userId);
    const slugs: Record<string, string> = user.travel_slugs || {};
    const firstId = Object.values(slugs)[0];
    if (firstId) {
      try { await this.pb().collection("travel_logs").getOne(firstId); return firstId; } catch {}
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

  // --- Trip Proposals ---

  async addProposal(tripId: string, proposal: Omit<TripProposal, "id" | "trip" | "state" | "resolvedAt" | "created" | "updated">): Promise<string> {
    const id = newId();
    await this.wpb.collection("trip_proposals").create({
      id,
      trip: tripId,
      question: proposal.question || "",
      reasoning: proposal.reasoning || "",
      candidate_ids: proposal.candidateIds || [],
      claude_picks: proposal.claudePicks || [],
      feedback: proposal.feedback || {},
      overall_feedback: proposal.overallFeedback || "",
      state: "open",
    });
    return id;
  }

  async updateProposal(proposalId: string, updates: Partial<Omit<TripProposal, "id" | "trip" | "created" | "updated">>): Promise<void> {
    const d: Record<string, unknown> = {};
    if (updates.question !== undefined) d.question = updates.question;
    if (updates.reasoning !== undefined) d.reasoning = updates.reasoning;
    if (updates.candidateIds !== undefined) d.candidate_ids = updates.candidateIds;
    if (updates.claudePicks !== undefined) d.claude_picks = updates.claudePicks;
    if (updates.feedback !== undefined) d.feedback = updates.feedback;
    if (updates.overallFeedback !== undefined) d.overall_feedback = updates.overallFeedback;
    if (updates.state !== undefined) d.state = updates.state;
    if (updates.resolvedAt !== undefined) d.resolved_at = updates.resolvedAt;
    if (updates.userRespondedAt !== undefined) d.user_responded_at = updates.userRespondedAt;
    if (updates.claudeLastSeenAt !== undefined) d.claude_last_seen_at = updates.claudeLastSeenAt;
    await this.wpb.collection("trip_proposals").update(proposalId, d);
  }

  async resolveProposal(proposalId: string): Promise<void> {
    await this.wpb.collection("trip_proposals").update(proposalId, {
      state: "resolved",
      resolved_at: new Date().toISOString(),
    });
  }

  async deleteProposal(proposalId: string): Promise<void> {
    await this.wpb.collection("trip_proposals").delete(proposalId);
  }

  async getProposal(proposalId: string): Promise<TripProposal | null> {
    try {
      const r = await this.pb().collection("trip_proposals").getOne(proposalId);
      return proposalFromRecord(r);
    } catch {
      return null;
    }
  }

  async listProposals(tripId: string, state?: "open" | "resolved"): Promise<TripProposal[]> {
    let filter = this.pb().filter("trip = {:tripId}", { tripId });
    if (state) filter += ` && state = "${state}"`;
    const records = await this.pb().collection("trip_proposals").getFullList({
      filter,
      sort: "-created",
    });
    return records.map(proposalFromRecord);
  }

  // --- Day entries ---

  async upsertDayEntry(
    logId: string,
    tripId: string,
    date: string,
    fields: { text?: string; highlight?: string; mood?: number | null },
  ): Promise<string> {
    // Filter-based lookup against (trip, date) — server fetch only, since
    // local-cache filter evaluation is a v2 concern. After the lookup, the
    // write goes through wpb so the UI sees the change optimistically.
    const filter = this.pb().filter("trip = {:tripId} && date = {:date}", { tripId, date });
    const data: Record<string, unknown> = {};
    if (fields.text !== undefined) data.text = fields.text;
    if (fields.highlight !== undefined) data.highlight = fields.highlight;
    if (fields.mood !== undefined) data.mood = fields.mood ?? null;
    try {
      const existing = await this.pb().collection("travel_day_entries").getFirstListItem(filter, { $autoCancel: false });
      await this.wpb.collection("travel_day_entries").update(existing.id, data);
      return existing.id;
    } catch {
      const id = newId();
      await this.wpb.collection("travel_day_entries").create({
        id, log: logId, trip: tripId, date, ...data,
      });
      return id;
    }
  }

  async deleteDayEntry(entryId: string): Promise<void> {
    await this.wpb.collection("travel_day_entries").delete(entryId);
  }

  subscribeToLog(
    logId: string,
    handlers: {
      onLog: (log: TravelLog) => void;
      onTrips: (trips: Trip[]) => void;
      onActivities: (activities: Activity[]) => void;
      onItineraries: (itineraries: Itinerary[]) => void;
      onDayEntries: (entries: DayEntry[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const tripsMap = new Map<string, Trip>();
    const activitiesMap = new Map<string, Activity>();
    const itinerariesMap = new Map<string, Itinerary>();
    const dayEntriesMap = new Map<string, DayEntry>();

    // Log metadata — optimistic-aware via wpb.
    this.sub("travel_logs", logId, () => cancelled, unsubs, {
      onData: (r) => handlers.onLog(logFromRecord(r)),
      onDelete: () => handlers.onDeleted?.(),
    });

    // Trips
    this.subCol("travel_trips", () => cancelled, unsubs, {
      filter: this.pb().filter("log = {:logId}", { logId }), belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) tripsMap.set(r.id, tripFromRecord(r)); handlers.onTrips(Array.from(tripsMap.values())); },
      onChange: (a, r) => { if (a === "delete") tripsMap.delete(r.id); else tripsMap.set(r.id, tripFromRecord(r)); handlers.onTrips(Array.from(tripsMap.values())); },
    });

    // Activities
    this.subCol("travel_activities", () => cancelled, unsubs, {
      filter: this.pb().filter("log = {:logId}", { logId }), belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) activitiesMap.set(r.id, activityFromRecord(r)); handlers.onActivities(Array.from(activitiesMap.values())); },
      onChange: (a, r) => { if (a === "delete") activitiesMap.delete(r.id); else activitiesMap.set(r.id, activityFromRecord(r)); handlers.onActivities(Array.from(activitiesMap.values())); },
    });

    // Itineraries
    this.subCol("travel_itineraries", () => cancelled, unsubs, {
      filter: this.pb().filter("log = {:logId}", { logId }), belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) itinerariesMap.set(r.id, itineraryFromRecord(r)); handlers.onItineraries(Array.from(itinerariesMap.values())); },
      onChange: (a, r) => { if (a === "delete") itinerariesMap.delete(r.id); else itinerariesMap.set(r.id, itineraryFromRecord(r)); handlers.onItineraries(Array.from(itinerariesMap.values())); },
    });

    // Day entries
    this.subCol("travel_day_entries", () => cancelled, unsubs, {
      filter: this.pb().filter("log = {:logId}", { logId }), belongsTo: (r) => r.log === logId,
      onInitial: (rs) => { for (const r of rs) dayEntriesMap.set(r.id, dayEntryFromRecord(r)); handlers.onDayEntries(Array.from(dayEntriesMap.values())); },
      onChange: (a, r) => { if (a === "delete") dayEntriesMap.delete(r.id); else dayEntriesMap.set(r.id, dayEntryFromRecord(r)); handlers.onDayEntries(Array.from(dayEntriesMap.values())); },
    });

    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }

  private tripData(t: Partial<Omit<Trip, "id" | "log" | "created" | "updated">>): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (t.name !== undefined) d.name = t.name;
    if (t.destination !== undefined) d.destination = t.destination;
    if (t.startDate !== undefined) d.start_date = t.startDate;
    if (t.endDate !== undefined) d.end_date = t.endDate;
    if (t.notes !== undefined) d.notes = t.notes;
    if (t.flagged !== undefined) d.flagged_for_review = t.flagged;
    if (t.flagComment !== undefined) d.review_comment = t.flagComment;
    if (t.sourceRefs !== undefined) d.source_refs = t.sourceRefs;
    // Pass through extra fields (status, region, etc.)
    const mapped = new Set(["id", "log", "name", "destination", "startDate", "endDate", "notes", "flagged", "flagComment", "sourceRefs", "created", "updated"]);
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
    if (a.bookingReqs !== undefined) d.booking_reqs = a.bookingReqs;
    if (a.ratingCount !== undefined) d.rating_count = a.ratingCount;
    if (a.photoRef !== undefined) d.photo_ref = a.photoRef;
    if (a.flightInfo !== undefined) d.flight_info = a.flightInfo;
    if (a.verdict !== undefined) d.verdict = a.verdict ?? "";
    if (a.personalNotes !== undefined) d.personal_notes = a.personalNotes;
    if (a.experiencedAt !== undefined) d.experienced_at = a.experiencedAt;
    return d;
  }

  /** Subscribe to a single record. Optimistic events for that id are included. */
  private sub(
    col: string,
    id: string,
    cancelled: () => boolean,
    unsubs: Array<() => void>,
    cb: { onData: (r: RecordModel) => void; onDelete?: () => void },
  ) {
    this.wpb.collection(col)
      .subscribe(id, (e) => {
        if (cancelled()) return;
        if (e.action === "delete") cb.onDelete?.();
        else cb.onData(e.record);
      })
      .then((unsub) => unsubs.push(unsub));
  }

  /** Subscribe to a filtered collection with optimistic events. */
  private subCol(
    col: string,
    cancelled: () => boolean,
    unsubs: Array<() => void>,
    opts: {
      filter: string;
      belongsTo: (r: RecordModel) => boolean;
      onInitial: (rs: RecordModel[]) => void;
      onChange: (a: string, r: RecordModel) => void;
    },
  ) {
    let initialDone = false;
    const initial: RecordModel[] = [];
    this.wpb.collection(col)
      .subscribe("*", (e) => {
        if (cancelled() || !opts.belongsTo(e.record as RecordModel)) return;
        if (!initialDone) {
          initial.push(e.record);
          return;
        }
        opts.onChange(e.action, e.record);
      }, { filter: opts.filter, local: (r) => opts.belongsTo(r as RecordModel) })
      .then((unsub) => {
        unsubs.push(unsub);
        if (!cancelled()) {
          initialDone = true;
          opts.onInitial(initial);
        }
      });
  }
}
