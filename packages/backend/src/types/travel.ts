/** Travel domain types */

export interface TravelLog {
  id: string;
  name: string;
  owners: string[];
  checklists: ChecklistTemplate[];
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  items: ChecklistItem[];
}

export interface ChecklistItem {
  id: string;
  text: string;
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
  [key: string]: unknown;
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
  [key: string]: unknown;
}

export interface Itinerary {
  id: string;
  log: string;
  trip: string;
  name: string;
  days: ItineraryDay[];
}

export interface ItineraryDay {
  date: string;
  items: ItineraryItem[];
}

export interface ItineraryItem {
  time?: string;
  activityId?: string;
  description: string;
}
