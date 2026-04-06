import { onSnapshot, type Unsubscribe } from "firebase/firestore";
import {
  getLogRef,
  getTripsRef,
  getActivitiesRef,
  getItinerariesRef,
  setCurrentLogId,
  getUserRef,
} from "./firestore";
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

export function subscribeToUserSlugs(userId: string, dispatch: Dispatch): Unsubscribe {
  return onSnapshot(
    getUserRef(userId),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as Record<string, unknown>;
        dispatch({
          type: "SET_USER_SLUGS",
          slugs: (data.travelSlugs as Record<string, string>) || {},
        });
      } else {
        dispatch({ type: "SET_USER_SLUGS", slugs: {} });
      }
    },
    (error) => {
      console.error("Travel user slugs subscription error:", error);
    }
  );
}

export async function subscribeToLog(
  logId: string,
  _userId: string,
  dispatch: Dispatch
): Promise<Unsubscribe[]> {
  setCurrentLogId(logId);

  dispatch({ type: "CLEAR_DATA" });
  dispatch({ type: "SET_LOADING", loading: true });

  const unsubscribers: Unsubscribe[] = [];

  // Subscribe to log
  const logUnsub = onSnapshot(
    getLogRef(),
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as TravelLogStore;
        dispatch({ type: "SET_LOG", log: logFromStore(snapshot.id, data) });
      } else {
        dispatch({ type: "SET_LOG", log: null });
      }
    },
    (error) => {
      console.error("Travel log subscription error:", error);
    }
  );
  unsubscribers.push(logUnsub);

  // Subscribe to trips
  const tripsUnsub = onSnapshot(
    getTripsRef(),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as TripStore;
          dispatch({
            type: "SET_TRIP",
            trip: tripFromStore(change.doc.id, data),
          });
        } else if (change.type === "removed") {
          dispatch({ type: "REMOVE_TRIP", tripId: change.doc.id });
        }
      });
      dispatch({ type: "SET_LOADING", loading: false });
    },
    (error) => {
      console.error("Trips subscription error:", error);
      dispatch({ type: "SET_LOADING", loading: false });
    }
  );
  unsubscribers.push(tripsUnsub);

  // Subscribe to activities
  const activitiesUnsub = onSnapshot(
    getActivitiesRef(),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as ActivityStore;
          dispatch({
            type: "SET_ACTIVITY",
            activity: activityFromStore(change.doc.id, data),
          });
        } else if (change.type === "removed") {
          dispatch({ type: "REMOVE_ACTIVITY", activityId: change.doc.id });
        }
      });
    },
    (error) => {
      console.error("Activities subscription error:", error);
    }
  );
  unsubscribers.push(activitiesUnsub);

  // Subscribe to itineraries
  const itinerariesUnsub = onSnapshot(
    getItinerariesRef(),
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as ItineraryStore;
          dispatch({
            type: "SET_ITINERARY",
            itinerary: itineraryFromStore(change.doc.id, data),
          });
        } else if (change.type === "removed") {
          dispatch({ type: "REMOVE_ITINERARY", itineraryId: change.doc.id });
        }
      });
    },
    (error) => {
      console.error("Itineraries subscription error:", error);
    }
  );
  unsubscribers.push(itinerariesUnsub);

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
