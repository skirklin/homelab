/**
 * Supabase implementation of TravelBackend.
 *
 * Big surface, all mechanical: one realtime channel per log watching
 * travel_logs / travel_trips / travel_activities / travel_itineraries /
 * travel_day_entries, each filtered by log_id (the itineraries channel
 * additionally needs the activities/owners coming via separate fetch on
 * change).
 *
 * upsertDayEntry uses ON CONFLICT (trip_id, date) — Phase 2 schema has
 * the UNIQUE constraint already.
 *
 * getOrCreateLog mirrors the PB pattern: travel_slugs.default → adopt
 * any owned log → create. Self-heals if the slug pointer is stale.
 *
 * No optimistic write layer yet — Phase 3 first cut.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { TravelBackend } from "../interfaces/travel";
import type {
  TravelLog,
  Trip,
  Activity,
  ActivityVerdict,
  Itinerary,
  ItineraryDay,
  TripProposal,
  DayEntry,
  FlightInfo,
  CandidateFeedback,
} from "../types/travel";
import type { Unsubscribe } from "../types/common";

// ---- Row shapes --------------------------------------------------------

interface LogRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  travel_log_owners?: Array<{ user_id: string }>;
}

interface TripRow {
  id: string;
  log_id: string;
  destination: string;
  status: string | null;
  region: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  source_refs: string | null;
  flagged_for_review: boolean | null;
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  log_id: string;
  trip_id: string | null;
  name: string;
  category: string | null;
  location: string | null;
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  description: string | null;
  cost_notes: string | null;
  duration_estimate: string | null;
  confirmation_code: string | null;
  details: string | null;
  setting: string | null;
  booking_reqs: unknown[] | null;
  rating: number | null;
  rating_count: number | null;
  photo_ref: string | null;
  flight_info: FlightInfo | null;
  verdict: ActivityVerdict | null;
  personal_notes: string | null;
  experienced_at: string | null;
  distance_miles: number | null;
  walk_miles: number | null;
  elevation_gain_feet: number | null;
  difficulty: string | null;
  created_at: string;
  updated_at: string;
}

interface ItineraryRow {
  id: string;
  log_id: string;
  trip_id: string;
  name: string;
  is_active: boolean | null;
  days: ItineraryDay[] | null;
  created_at: string;
  updated_at: string;
}

interface DayEntryRow {
  id: string;
  log_id: string;
  trip_id: string;
  date: string;
  text: string | null;
  highlight: string | null;
  mood: number | null;
  created_at: string;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  trip_id: string;
  question: string;
  reasoning: string | null;
  candidate_ids: string[] | null;
  claude_picks: string[] | null;
  feedback: Record<string, CandidateFeedback> | null;
  overall_feedback: string | null;
  state: "open" | "resolved";
  resolved_at: string | null;
  user_responded_at: string | null;
  claude_last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Mappers -----------------------------------------------------------

function logFromRow(r: LogRow): TravelLog {
  return {
    id: r.id,
    name: r.name,
    owners: r.travel_log_owners?.map((o) => o.user_id) ?? [],
    created: r.created_at,
    updated: r.updated_at,
  };
}

function tripFromRow(r: TripRow): Trip {
  return {
    id: r.id,
    log: r.log_id,
    // PB never stored a real `name` — keep blank for parity; callers use
    // `destination` as the human-facing label.
    name: "",
    destination: r.destination,
    startDate: r.start_date ?? "",
    endDate: r.end_date ?? "",
    notes: r.notes ?? "",
    flagged: !!r.flagged_for_review,
    flagComment: r.review_comment ?? "",
    status: r.status ?? "",
    region: r.region ?? "",
    sourceRefs: r.source_refs ?? "",
    created: r.created_at,
    updated: r.updated_at,
  };
}

function activityFromRow(r: ActivityRow): Activity {
  return {
    id: r.id,
    log: r.log_id,
    trip: r.trip_id ?? undefined,
    name: r.name,
    location: r.location ?? "",
    lat: r.lat ?? undefined,
    lng: r.lng ?? undefined,
    placeId: r.place_id ?? undefined,
    description: r.description ?? "",
    rating: r.rating ?? undefined,
    tags: [], // travel_activities has no tags column in current PB schema
    category: r.category ?? "",
    costNotes: r.cost_notes ?? "",
    durationEstimate: r.duration_estimate ?? "",
    walkMiles: r.walk_miles ?? undefined,
    elevationGainFeet: r.elevation_gain_feet ?? undefined,
    difficulty: r.difficulty ?? undefined,
    confirmationCode: r.confirmation_code ?? "",
    details: r.details ?? undefined,
    setting: r.setting ?? undefined,
    bookingReqs: r.booking_reqs ?? undefined,
    ratingCount: r.rating_count ?? undefined,
    photoRef: r.photo_ref ?? undefined,
    flightInfo: r.flight_info ?? undefined,
    verdict: r.verdict ?? undefined,
    personalNotes: r.personal_notes ?? undefined,
    experiencedAt: r.experienced_at ?? undefined,
    created: r.created_at,
    updated: r.updated_at,
  };
}

function itineraryFromRow(r: ItineraryRow): Itinerary {
  return {
    id: r.id,
    log: r.log_id,
    trip: r.trip_id,
    name: r.name,
    isActive: r.is_active ?? true,
    days: r.days ?? [],
    created: r.created_at,
    updated: r.updated_at,
  };
}

function dayEntryFromRow(r: DayEntryRow): DayEntry {
  return {
    id: r.id,
    log: r.log_id,
    trip: r.trip_id,
    date: r.date,
    text: r.text ?? "",
    highlight: r.highlight ?? undefined,
    mood: r.mood ?? undefined,
    created: r.created_at,
    updated: r.updated_at,
  };
}

function proposalFromRow(r: ProposalRow): TripProposal {
  return {
    id: r.id,
    trip: r.trip_id,
    question: r.question,
    reasoning: r.reasoning ?? "",
    candidateIds: r.candidate_ids ?? [],
    claudePicks: r.claude_picks ?? [],
    feedback: r.feedback ?? {},
    overallFeedback: r.overall_feedback ?? "",
    state: r.state,
    resolvedAt: r.resolved_at ?? undefined,
    userRespondedAt: r.user_responded_at ?? undefined,
    claudeLastSeenAt: r.claude_last_seen_at ?? undefined,
    created: r.created_at,
    updated: r.updated_at,
  };
}

// ---- Domain → row mapping helpers -------------------------------------

function tripPatch(
  t: Partial<Omit<Trip, "id" | "log" | "created" | "updated">>,
): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (t.destination !== undefined) d.destination = t.destination;
  if (t.status !== undefined) d.status = t.status || null;
  if (t.region !== undefined) d.region = t.region || null;
  if (t.startDate !== undefined) d.start_date = t.startDate || null;
  if (t.endDate !== undefined) d.end_date = t.endDate || null;
  if (t.notes !== undefined) d.notes = t.notes;
  if (t.sourceRefs !== undefined) d.source_refs = t.sourceRefs;
  if (t.flagged !== undefined) d.flagged_for_review = t.flagged;
  if (t.flagComment !== undefined) d.review_comment = t.flagComment;
  return d;
}

function activityPatch(
  a: Partial<Omit<Activity, "id" | "log" | "created" | "updated">>,
): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (a.trip !== undefined) d.trip_id = a.trip || null;
  if (a.name !== undefined) d.name = a.name;
  if (a.location !== undefined) d.location = a.location;
  if (a.lat !== undefined) d.lat = a.lat;
  if (a.lng !== undefined) d.lng = a.lng;
  if (a.placeId !== undefined) d.place_id = a.placeId;
  if (a.description !== undefined) d.description = a.description;
  if (a.rating !== undefined) d.rating = a.rating;
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
  if (a.verdict !== undefined) d.verdict = a.verdict ?? null;
  if (a.personalNotes !== undefined) d.personal_notes = a.personalNotes;
  if (a.experiencedAt !== undefined) d.experienced_at = a.experiencedAt;
  return d;
}

const LOG_SELECT = "*, travel_log_owners(user_id)";

// ---- Backend impl ------------------------------------------------------

export class SupabaseTravelBackend implements TravelBackend {
  constructor(private client: SupabaseClient) {}

  // ----- Log -------------------------------------------------------------

  async getOrCreateLog(userId: string): Promise<string> {
    // 1. Honor the existing travel_slugs.default pointer if it resolves.
    const { data: profile } = await this.client
      .from("user_profiles")
      .select("travel_slugs")
      .eq("id", userId)
      .maybeSingle();
    const slugs: Record<string, string> =
      (profile?.travel_slugs as Record<string, string> | null) ?? {};
    const firstId: string | undefined = Object.values(slugs)[0];

    if (firstId) {
      const { data: existing } = await this.client
        .from("travel_logs")
        .select("id")
        .eq("id", firstId)
        .maybeSingle();
      if (existing) return firstId;
      // pointer is stale; fall through to recovery
    }

    // 2. Adopt any travel_log this user owns.
    const { data: owned } = await this.client
      .from("travel_log_owners")
      .select("log_id, travel_logs!inner(id)")
      .eq("user_id", userId)
      .order("log_id", { ascending: true })
      .limit(1);
    if (owned && owned.length > 0) {
      const logId = (owned[0] as unknown as { log_id: string }).log_id;
      await this.setSlugPointer(userId, slugs, firstId, logId);
      return logId;
    }

    // 3. Create a fresh log.
    const { data: created, error: createErr } = await this.client
      .from("travel_logs")
      .insert({ name: "My Travel Log" })
      .select("id")
      .single();
    if (createErr) throw createErr;

    const { error: ownerErr } = await this.client
      .from("travel_log_owners")
      .insert({ log_id: created.id, user_id: userId });
    if (ownerErr) {
      await this.client.from("travel_logs").delete().eq("id", created.id);
      throw ownerErr;
    }
    await this.setSlugPointer(userId, slugs, firstId, created.id);
    return created.id;
  }

  private async setSlugPointer(
    userId: string,
    slugs: Record<string, string>,
    staleValue: string | undefined,
    newId: string,
  ): Promise<void> {
    const next = { ...slugs };
    let updated = false;
    if (staleValue) {
      for (const [k, v] of Object.entries(next)) {
        if (v === staleValue) {
          next[k] = newId;
          updated = true;
        }
      }
    }
    if (!updated) next.default = newId;
    const { error } = await this.client
      .from("user_profiles")
      .upsert({ id: userId, travel_slugs: next }, { onConflict: "id" });
    if (error) throw error;
  }

  // ----- Trip CRUD ------------------------------------------------------

  async addTrip(
    logId: string,
    trip: Omit<Trip, "id" | "log" | "created" | "updated">,
  ): Promise<string> {
    const { data, error } = await this.client
      .from("travel_trips")
      .insert({ log_id: logId, ...tripPatch(trip) })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async updateTrip(
    tripId: string,
    updates: Partial<Omit<Trip, "id" | "log" | "created" | "updated">>,
  ): Promise<void> {
    const patch = tripPatch(updates);
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client
      .from("travel_trips")
      .update(patch)
      .eq("id", tripId);
    if (error) throw error;
  }

  async deleteTrip(tripId: string): Promise<void> {
    const { error } = await this.client.from("travel_trips").delete().eq("id", tripId);
    if (error) throw error;
  }

  async flagTrip(tripId: string, flagged: boolean, comment?: string): Promise<void> {
    const { error } = await this.client
      .from("travel_trips")
      .update({ flagged_for_review: flagged, review_comment: comment ?? "" })
      .eq("id", tripId);
    if (error) throw error;
  }

  // ----- Activity CRUD --------------------------------------------------

  async addActivity(
    logId: string,
    activity: Omit<Activity, "id" | "log" | "created" | "updated">,
  ): Promise<string> {
    const { data, error } = await this.client
      .from("travel_activities")
      .insert({ log_id: logId, ...activityPatch(activity) })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async updateActivity(
    activityId: string,
    updates: Partial<Omit<Activity, "id" | "log" | "created" | "updated">>,
  ): Promise<void> {
    const patch = activityPatch(updates);
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client
      .from("travel_activities")
      .update(patch)
      .eq("id", activityId);
    if (error) throw error;
  }

  async deleteActivity(activityId: string): Promise<void> {
    const { error } = await this.client
      .from("travel_activities")
      .delete()
      .eq("id", activityId);
    if (error) throw error;
  }

  // ----- Itinerary CRUD -------------------------------------------------

  async addItinerary(
    logId: string,
    tripId: string,
    itinerary: Omit<Itinerary, "id" | "log" | "trip" | "created" | "updated">,
  ): Promise<string> {
    const { data, error } = await this.client
      .from("travel_itineraries")
      .insert({
        log_id: logId,
        trip_id: tripId,
        name: itinerary.name,
        is_active: itinerary.isActive ?? true,
        days: itinerary.days ?? [],
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async updateItinerary(
    itineraryId: string,
    updates: Partial<Omit<Itinerary, "id" | "log" | "trip" | "created" | "updated">>,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.isActive !== undefined) patch.is_active = updates.isActive;
    if (updates.days !== undefined) patch.days = updates.days;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client
      .from("travel_itineraries")
      .update(patch)
      .eq("id", itineraryId);
    if (error) throw error;
  }

  async setItineraryDays(itineraryId: string, days: ItineraryDay[]): Promise<void> {
    const { error } = await this.client
      .from("travel_itineraries")
      .update({ days })
      .eq("id", itineraryId);
    if (error) throw error;
  }

  async deleteItinerary(itineraryId: string): Promise<void> {
    const { error } = await this.client
      .from("travel_itineraries")
      .delete()
      .eq("id", itineraryId);
    if (error) throw error;
  }

  // ----- Trip Proposals -------------------------------------------------

  async addProposal(
    tripId: string,
    proposal: Omit<TripProposal, "id" | "trip" | "state" | "resolvedAt" | "created" | "updated">,
  ): Promise<string> {
    const { data, error } = await this.client
      .from("trip_proposals")
      .insert({
        trip_id: tripId,
        question: proposal.question || "",
        reasoning: proposal.reasoning || "",
        candidate_ids: proposal.candidateIds ?? [],
        claude_picks: proposal.claudePicks ?? [],
        feedback: proposal.feedback ?? {},
        overall_feedback: proposal.overallFeedback || "",
        state: "open",
        user_responded_at: proposal.userRespondedAt ?? null,
        claude_last_seen_at: proposal.claudeLastSeenAt ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async updateProposal(
    proposalId: string,
    updates: Partial<Omit<TripProposal, "id" | "trip" | "created" | "updated">>,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (updates.question !== undefined) patch.question = updates.question;
    if (updates.reasoning !== undefined) patch.reasoning = updates.reasoning;
    if (updates.candidateIds !== undefined) patch.candidate_ids = updates.candidateIds;
    if (updates.claudePicks !== undefined) patch.claude_picks = updates.claudePicks;
    if (updates.feedback !== undefined) patch.feedback = updates.feedback;
    if (updates.overallFeedback !== undefined) patch.overall_feedback = updates.overallFeedback;
    if (updates.state !== undefined) patch.state = updates.state;
    if (updates.resolvedAt !== undefined) patch.resolved_at = updates.resolvedAt;
    if (updates.userRespondedAt !== undefined) patch.user_responded_at = updates.userRespondedAt;
    if (updates.claudeLastSeenAt !== undefined) patch.claude_last_seen_at = updates.claudeLastSeenAt;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.client
      .from("trip_proposals")
      .update(patch)
      .eq("id", proposalId);
    if (error) throw error;
  }

  async resolveProposal(proposalId: string): Promise<void> {
    const { error } = await this.client
      .from("trip_proposals")
      .update({ state: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", proposalId);
    if (error) throw error;
  }

  async deleteProposal(proposalId: string): Promise<void> {
    const { error } = await this.client.from("trip_proposals").delete().eq("id", proposalId);
    if (error) throw error;
  }

  async getProposal(proposalId: string): Promise<TripProposal | null> {
    const { data, error } = await this.client
      .from("trip_proposals")
      .select("*")
      .eq("id", proposalId)
      .maybeSingle();
    if (error || !data) return null;
    return proposalFromRow(data as ProposalRow);
  }

  async listProposals(tripId: string, state?: "open" | "resolved"): Promise<TripProposal[]> {
    let q = this.client
      .from("trip_proposals")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false });
    if (state) q = q.eq("state", state);
    const { data, error } = await q;
    if (error || !data) return [];
    return (data as ProposalRow[]).map(proposalFromRow);
  }

  // ----- Day entries ----------------------------------------------------

  async upsertDayEntry(
    logId: string,
    tripId: string,
    date: string,
    fields: { text?: string; highlight?: string; mood?: number | null },
  ): Promise<string> {
    const row: Record<string, unknown> = { log_id: logId, trip_id: tripId, date };
    if (fields.text !== undefined) row.text = fields.text;
    if (fields.highlight !== undefined) row.highlight = fields.highlight;
    if (fields.mood !== undefined) row.mood = fields.mood ?? null;

    const { data, error } = await this.client
      .from("travel_day_entries")
      .upsert(row, { onConflict: "trip_id,date" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async deleteDayEntry(entryId: string): Promise<void> {
    const { error } = await this.client
      .from("travel_day_entries")
      .delete()
      .eq("id", entryId);
    if (error) throw error;
  }

  // ----- Subscriptions --------------------------------------------------

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
    const tripsMap = new Map<string, Trip>();
    const activitiesMap = new Map<string, Activity>();
    const itinerariesMap = new Map<string, Itinerary>();
    const dayEntriesMap = new Map<string, DayEntry>();

    const emitTrips = () => { if (!cancelled) handlers.onTrips(Array.from(tripsMap.values())); };
    const emitActs = () => { if (!cancelled) handlers.onActivities(Array.from(activitiesMap.values())); };
    const emitItins = () => { if (!cancelled) handlers.onItineraries(Array.from(itinerariesMap.values())); };
    const emitDays = () => { if (!cancelled) handlers.onDayEntries(Array.from(dayEntriesMap.values())); };

    const reloadLog = async () => {
      const { data } = await this.client
        .from("travel_logs")
        .select(LOG_SELECT)
        .eq("id", logId)
        .maybeSingle();
      if (cancelled || !data) return;
      handlers.onLog(logFromRow(data as LogRow));
    };

    const channel: RealtimeChannel = this.client
      .channel(`travel-log-${logId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "travel_logs", filter: `id=eq.${logId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") handlers.onDeleted?.();
          else void reloadLog();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "travel_trips", filter: `log_id=eq.${logId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<TripRow>;
            if (old.id) tripsMap.delete(old.id);
          } else {
            const row = payload.new as TripRow;
            tripsMap.set(row.id, tripFromRow(row));
          }
          emitTrips();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "travel_activities", filter: `log_id=eq.${logId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<ActivityRow>;
            if (old.id) activitiesMap.delete(old.id);
          } else {
            const row = payload.new as ActivityRow;
            activitiesMap.set(row.id, activityFromRow(row));
          }
          emitActs();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "travel_itineraries", filter: `log_id=eq.${logId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<ItineraryRow>;
            if (old.id) itinerariesMap.delete(old.id);
          } else {
            const row = payload.new as ItineraryRow;
            itinerariesMap.set(row.id, itineraryFromRow(row));
          }
          emitItins();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "travel_day_entries", filter: `log_id=eq.${logId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<DayEntryRow>;
            if (old.id) dayEntriesMap.delete(old.id);
          } else {
            const row = payload.new as DayEntryRow;
            dayEntriesMap.set(row.id, dayEntryFromRow(row));
          }
          emitDays();
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || cancelled) return;
        const [trips, activities, itineraries, dayEntries] = await Promise.all([
          this.client.from("travel_trips").select("*").eq("log_id", logId),
          this.client.from("travel_activities").select("*").eq("log_id", logId),
          this.client.from("travel_itineraries").select("*").eq("log_id", logId),
          this.client.from("travel_day_entries").select("*").eq("log_id", logId),
        ]);
        if (cancelled) return;
        tripsMap.clear();
        activitiesMap.clear();
        itinerariesMap.clear();
        dayEntriesMap.clear();
        if (trips.data) for (const r of trips.data as TripRow[]) tripsMap.set(r.id, tripFromRow(r));
        if (activities.data) for (const r of activities.data as ActivityRow[]) activitiesMap.set(r.id, activityFromRow(r));
        if (itineraries.data) for (const r of itineraries.data as ItineraryRow[]) itinerariesMap.set(r.id, itineraryFromRow(r));
        if (dayEntries.data) for (const r of dayEntries.data as DayEntryRow[]) dayEntriesMap.set(r.id, dayEntryFromRow(r));
        emitTrips();
        emitActs();
        emitItins();
        emitDays();
        await reloadLog();
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(channel);
    };
  }
}
