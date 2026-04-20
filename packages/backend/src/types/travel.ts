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
  from?: string;          // airport code, e.g. "SFO"
  to?: string;            // airport code, e.g. "JFK"
  departsAt?: string;     // ISO datetime
  arrivesAt?: string;     // ISO datetime
}

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
  confirmationCode: string;
  details?: string;
  setting?: string;
  bookingReqs?: unknown[];
  ratingCount?: number;
  photoRef?: string;
  flightInfo?: FlightInfo;
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
