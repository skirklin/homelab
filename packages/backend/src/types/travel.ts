/** Travel domain types */

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

/** A proposal is a curated comparison of candidate activities Claude presents
 *  to the user for feedback during trip planning. */
export interface CandidateFeedback {
  vote?: "up" | "down";
  picked?: boolean;
  notes?: string;
}

export interface TripProposal {
  id: string;
  trip: string;
  question: string;
  reasoning: string;
  candidateIds: string[];
  claudePicks: string[];
  feedback: Record<string, CandidateFeedback>;
  overallFeedback: string;
  state: "open" | "resolved";
  resolvedAt?: string;
  userRespondedAt?: string;
  claudeLastSeenAt?: string;
  created: string;
  updated: string;
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
  confirmationCode: string;
  details?: string;
  setting?: string;
  bookingReqs?: unknown[];
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
