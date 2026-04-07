/**
 * PocketBase real-time subscriptions for the travel app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import { getBackend } from "@kirkl/shared";
import { setCurrentLogId, getUserSlugs } from "./pocketbase";
import type {
  TripStore,
  TravelLogStore,
  ActivityStore,
  ItineraryStore,
} from "./types";
import {
  tripFromStore,
  logFromStore,
  activityFromStore,
  itineraryFromStore,
} from "./types";
import type { TravelAction } from "./travel-context";

type Dispatch = React.Dispatch<TravelAction>;

function pb() {
  return getBackend();
}

export async function loadUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean) {
  try {
    const slugs = await getUserSlugs(userId, { $autoCancel: false });
    if (cancelled()) return;
    dispatch({ type: "SET_USER_SLUGS", slugs });
  } catch (err) {
    console.error("[travel] loadUserSlugs failed:", err);
  }
}

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch, cancelled: () => boolean): () => void {
  // Load initial slugs
  loadUserSlugs(userId, dispatch, cancelled).catch(console.error);

  // Subscribe to user record changes
  pb().collection("users").subscribe(userId, (e) => {
    if (cancelled()) return;
    dispatch({
      type: "SET_USER_SLUGS",
      slugs: (e.record.travel_slugs as Record<string, string>) || {},
    });
  });

  return () => {
    pb().collection("users").unsubscribe(userId);
  };
}

export async function subscribeToLog(
  logId: string,
  _userId: string,
  dispatch: Dispatch,
  cancelled: () => boolean
): Promise<Array<() => void>> {
  setCurrentLogId(logId);

  dispatch({ type: "CLEAR_DATA" });
  dispatch({ type: "SET_LOADING", loading: true });

  const unsubscribers: Array<() => void> = [];
  const opts = { $autoCancel: false };

  // Load initial log data
  try {
    const log = await pb().collection("travel_logs").getOne(logId, opts);
    if (cancelled()) return unsubscribers;
    dispatch({ type: "SET_LOG", log: logFromStore(log as unknown as TravelLogStore) });
  } catch {
    if (cancelled()) return unsubscribers;
    dispatch({ type: "SET_LOG", log: null });
  }

  // Subscribe to log changes
  pb().collection("travel_logs").subscribe(logId, (e) => {
    if (cancelled()) return;
    if (e.action === "delete") {
      dispatch({ type: "SET_LOG", log: null });
    } else {
      dispatch({ type: "SET_LOG", log: logFromStore(e.record as unknown as TravelLogStore) });
    }
  });
  unsubscribers.push(() => pb().collection("travel_logs").unsubscribe(logId));

  // Load initial trips
  try {
    const trips = await pb().collection("travel_trips").getFullList({
      filter: `log = "${logId}"`,
      $autoCancel: false,
    });
    if (cancelled()) return unsubscribers;
    for (const trip of trips) {
      dispatch({ type: "SET_TRIP", trip: tripFromStore(trip as unknown as TripStore) });
    }
  } catch (e) {
    console.error("Failed to load trips:", e);
  }
  if (cancelled()) return unsubscribers;
  dispatch({ type: "SET_LOADING", loading: false });

  // Subscribe to trip changes
  pb().collection("travel_trips").subscribe("*", (e) => {
    if (cancelled()) return;
    if ((e.record as unknown as TripStore).log !== logId) return;
    if (e.action === "delete") {
      dispatch({ type: "REMOVE_TRIP", tripId: e.record.id });
    } else {
      dispatch({ type: "SET_TRIP", trip: tripFromStore(e.record as unknown as TripStore) });
    }
  });
  unsubscribers.push(() => pb().collection("travel_trips").unsubscribe("*"));

  // Load initial activities
  try {
    const activities = await pb().collection("travel_activities").getFullList({
      filter: `log = "${logId}"`,
      $autoCancel: false,
    });
    if (cancelled()) return unsubscribers;
    for (const activity of activities) {
      dispatch({ type: "SET_ACTIVITY", activity: activityFromStore(activity as unknown as ActivityStore) });
    }
  } catch (e) {
    console.error("Failed to load activities:", e);
  }

  // Subscribe to activity changes
  pb().collection("travel_activities").subscribe("*", (e) => {
    if (cancelled()) return;
    if ((e.record as unknown as ActivityStore).log !== logId) return;
    if (e.action === "delete") {
      dispatch({ type: "REMOVE_ACTIVITY", activityId: e.record.id });
    } else {
      dispatch({ type: "SET_ACTIVITY", activity: activityFromStore(e.record as unknown as ActivityStore) });
    }
  });
  unsubscribers.push(() => pb().collection("travel_activities").unsubscribe("*"));

  // Load initial itineraries
  try {
    const itineraries = await pb().collection("travel_itineraries").getFullList({
      filter: `log = "${logId}"`,
      $autoCancel: false,
    });
    if (cancelled()) return unsubscribers;
    for (const itinerary of itineraries) {
      dispatch({ type: "SET_ITINERARY", itinerary: itineraryFromStore(itinerary as unknown as ItineraryStore) });
    }
  } catch (e) {
    console.error("Failed to load itineraries:", e);
  }

  // Subscribe to itinerary changes
  pb().collection("travel_itineraries").subscribe("*", (e) => {
    if (cancelled()) return;
    if ((e.record as unknown as ItineraryStore).log !== logId) return;
    if (e.action === "delete") {
      dispatch({ type: "REMOVE_ITINERARY", itineraryId: e.record.id });
    } else {
      dispatch({ type: "SET_ITINERARY", itinerary: itineraryFromStore(e.record as unknown as ItineraryStore) });
    }
  });
  unsubscribers.push(() => pb().collection("travel_itineraries").unsubscribe("*"));

  return unsubscribers;
}

// Helper: get trips grouped by status
export function getTripsByStatus(trips: Map<string, import("./types").Trip>) {
  const grouped: Record<string, import("./types").Trip[]> = {
    Ongoing: [],
    Booked: [],
    Researching: [],
    Idea: [],
    Completed: [],
  };

  for (const trip of trips.values()) {
    const bucket = grouped[trip.status];
    if (bucket) {
      bucket.push(trip);
    } else {
      grouped.Idea.push(trip);
    }
  }

  // Sort each bucket by date
  for (const trips of Object.values(grouped)) {
    trips.sort((a, b) => {
      const aDate = a.startDate?.getTime() ?? a.created.getTime();
      const bDate = b.startDate?.getTime() ?? b.created.getTime();
      return bDate - aDate; // Newest first
    });
  }

  return grouped;
}

// Helper: get activities for a specific trip
export function getActivitiesForTrip(
  activities: Map<string, import("./types").Activity>,
  tripId: string
) {
  return Array.from(activities.values()).filter((a) => a.tripId === tripId);
}

// Helper: get itineraries for a specific trip
export function getItinerariesForTrip(
  itineraries: Map<string, import("./types").Itinerary>,
  tripId: string
) {
  return Array.from(itineraries.values()).filter((i) => i.tripId === tripId);
}
