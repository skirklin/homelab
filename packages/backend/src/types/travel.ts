/** Travel domain types */

export interface TravelLog {
  id: string;
  name: string;
  owners: string[];
  checklists: ChecklistTemplate[];
  created?: string;
  updated?: string;
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  items: ChecklistItem[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  category?: string;
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
  checklistDone: Record<string, boolean>;
  status: string;
  region: string;
  sourceRefs: string;
  created?: string;
  updated?: string;
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
  notes: string;
  rating?: number;
  tags: string[];
  category: string;
  costNotes: string;
  durationEstimate: string;
  confirmationCode: string;
  // PocketBase snake_case aliases (set when writing, read when loading)
  cost_notes?: string;
  duration_estimate?: string;
  confirmation_code?: string;
  trip_id?: string;
  // Extra fields used by the travel app
  details?: string;
  setting?: string;
  booking_reqs?: string[];
  bookingReqs?: string[];
  rating_count?: number;
  ratingCount?: number;
  photo_ref?: string;
  photoRef?: string;
  created?: string;
  updated?: string;
}

export interface Itinerary {
  id: string;
  log: string;
  trip: string;
  name: string;
  isActive?: boolean;
  days: ItineraryDay[];
  created?: string;
  updated?: string;
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
