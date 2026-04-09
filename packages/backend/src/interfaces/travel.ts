/**
 * Travel backend interface.
 *
 * Covers: logs, trips, activities, itineraries, checklists.
 */
import type { Unsubscribe } from "../types/common";
import type {
  TravelLog,
  Trip,
  Activity,
  Itinerary,
  ItineraryDay,
  ChecklistTemplate,
} from "../types/travel";

export interface TravelBackend {
  // --- Log ---

  /** Get or create the user's travel log. Returns the log ID. */
  getOrCreateLog(userId: string): Promise<string>;
  updateLogChecklists(logId: string, checklists: ChecklistTemplate[]): Promise<void>;

  // --- Trip CRUD ---

  addTrip(logId: string, trip: Omit<Trip, "id" | "log">): Promise<string>;
  updateTrip(tripId: string, updates: Partial<Omit<Trip, "id" | "log">>): Promise<void>;
  deleteTrip(tripId: string): Promise<void>;
  flagTrip(tripId: string, flagged: boolean, comment?: string): Promise<void>;
  toggleChecklistItem(tripId: string, itemId: string, done: boolean): Promise<void>;

  // --- Activity CRUD ---

  addActivity(logId: string, activity: Omit<Activity, "id" | "log">): Promise<string>;
  updateActivity(activityId: string, updates: Partial<Omit<Activity, "id" | "log">>): Promise<void>;
  deleteActivity(activityId: string): Promise<void>;

  // --- Itinerary CRUD ---

  addItinerary(logId: string, tripId: string, itinerary: Omit<Itinerary, "id" | "log" | "trip">): Promise<string>;
  updateItinerary(itineraryId: string, updates: Partial<Omit<Itinerary, "id" | "log" | "trip">>): Promise<void>;
  setItineraryDays(itineraryId: string, days: ItineraryDay[]): Promise<void>;
  deleteItinerary(itineraryId: string): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to all data for a travel log.
   * Callbacks receive full current state on initial load and after every change.
   */
  subscribeToLog(
    logId: string,
    handlers: {
      onLog: (log: TravelLog) => void;
      onTrips: (trips: Trip[]) => void;
      onActivities: (activities: Activity[]) => void;
      onItineraries: (itineraries: Itinerary[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe;
}
