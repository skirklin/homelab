/** Travel domain types */

import type { LifeEntry } from "./life";

export interface TravelLog {
  id: string;
  name: string;
  owners: string[];
  created: string;
  updated: string;
}

export interface Trip {
  id: string;
  log: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  notes: string;
  flagged: boolean;
  flagComment: string;
  status: string;
  region: string;
  sourceRefs: string;
  created: string;
  updated: string;
}

export interface FlightInfo {
  airline?: string;       // e.g. "United", "UA", "SW"
  number?: string;        // e.g. "1234", "2929"
  from?: string;          // departure airport code, e.g. "SFO"
  to?: string;            // arrival airport code, e.g. "JFK"
  fromLat?: number;       // departure airport lat
  fromLng?: number;       // departure airport lng
  toLat?: number;         // arrival airport lat
  toLng?: number;         // arrival airport lng
  departsAt?: string;     // ISO datetime
  arrivesAt?: string;     // ISO datetime
  fromIsHome?: boolean;   // departure is the user's home airport
  toIsHome?: boolean;     // arrival is the user's home airport
}

export type ActivityVerdict = "loved" | "liked" | "meh" | "skip";

export interface Activity {
  id: string;
  log: string;
  trip?: string;
  name: string;
  location: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  description: string;
  rating?: number;
  tags: string[];
  category: string;
  costNotes: string;
  durationEstimate: string;
  walkMiles?: number;
  elevationGainFeet?: number;
  difficulty?: string;
  confirmationCode: string;
  details?: string;
  setting?: string;
  ratingCount?: number;
  photoRef?: string;
  flightInfo?: FlightInfo;
  // Post-experience reflection. `verdict` and `personalNotes` are the user's
  // own feedback, distinct from `rating`/`ratingCount` (Google Places aggregate).
  verdict?: ActivityVerdict;
  personalNotes?: string;
  experiencedAt?: string;
  created: string;
  updated: string;
}

/** A free-form day journal, keyed by (trip, date). Lives outside itineraries
 *  so it survives itinerary regenerations. */
export interface DayEntry {
  id: string;
  log: string;
  trip: string;
  date: string;        // YYYY-MM-DD, matches ItineraryDay.date
  text: string;
  highlight?: string;  // optional one-line "best moment"
  mood?: number;       // 1..5 overall day rating
  created: string;
  updated: string;
}

/**
 * A per-user piece of feedback attached to a subject (an activity, a whole
 * trip, or a single day). The shared `entries[]` shape (identical to
 * recipe_events / life_events) so the same structured-data widgets render it.
 *
 * `subjectType` is `activity` | `day` | `trip` (validated app-side; the PB
 * column is plain text). `subjectId` resolves per type: activity→activity id,
 * trip→trip id, day→composite `"${tripId}:${date}"` (split on the FIRST colon
 * to recover tripId/date). `createdBy` may be "" on backfilled rows.
 */
export interface TravelNote {
  id: string;
  log: string;
  subjectType: string;
  subjectId: string;
  createdBy: string;
  entries: LifeEntry[];
  created: string;
  updated: string;
}

export interface Itinerary {
  id: string;
  log: string;
  trip: string;
  name: string;
  isActive?: boolean;
  days: ItineraryDay[];
  created: string;
  updated: string;
}

export interface ActivitySlot {
  activityId: string;
  startTime?: string;
  notes?: string;
}

export type FlightSlot = ActivitySlot;

export interface ItineraryDay {
  date?: string;
  label: string;
  lodgingActivityId?: string;
  flights?: FlightSlot[];
  slots: ActivitySlot[];
}
