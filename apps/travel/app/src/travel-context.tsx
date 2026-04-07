import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { useAuth } from "@kirkl/shared";
import { subscribeToUserSlugs, subscribeToLog } from "./subscription";
import type { Trip, TravelLog, Activity, Itinerary } from "./types";

export interface TravelState {
  userSlugs: Record<string, string>;
  slugsLoaded: boolean;
  log: TravelLog | null;
  trips: Map<string, Trip>;
  activities: Map<string, Activity>;
  itineraries: Map<string, Itinerary>;
  loading: boolean;
}

export type TravelAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string>; }
  | { type: "SET_LOG"; log: TravelLog | null }
  | { type: "SET_TRIP"; trip: Trip }
  | { type: "REMOVE_TRIP"; tripId: string }
  | { type: "SET_ACTIVITY"; activity: Activity }
  | { type: "REMOVE_ACTIVITY"; activityId: string }
  | { type: "SET_ITINERARY"; itinerary: Itinerary }
  | { type: "REMOVE_ITINERARY"; itineraryId: string }
  | { type: "CLEAR_DATA" }
  | { type: "SET_LOADING"; loading: boolean };

function reducer(state: TravelState, action: TravelAction): TravelState {
  switch (action.type) {
    case "SET_USER_SLUGS":
      return { ...state, userSlugs: action.slugs, slugsLoaded: true };

    case "SET_LOG":
      return { ...state, log: action.log };

    case "SET_TRIP": {
      const newTrips = new Map(state.trips);
      newTrips.set(action.trip.id, action.trip);
      return { ...state, trips: newTrips };
    }

    case "REMOVE_TRIP": {
      const newTrips = new Map(state.trips);
      newTrips.delete(action.tripId);
      return { ...state, trips: newTrips };
    }

    case "SET_ACTIVITY": {
      const newActivities = new Map(state.activities);
      newActivities.set(action.activity.id, action.activity);
      return { ...state, activities: newActivities };
    }

    case "REMOVE_ACTIVITY": {
      const newActivities = new Map(state.activities);
      newActivities.delete(action.activityId);
      return { ...state, activities: newActivities };
    }

    case "SET_ITINERARY": {
      const newItineraries = new Map(state.itineraries);
      newItineraries.set(action.itinerary.id, action.itinerary);
      return { ...state, itineraries: newItineraries };
    }

    case "REMOVE_ITINERARY": {
      const newItineraries = new Map(state.itineraries);
      newItineraries.delete(action.itineraryId);
      return { ...state, itineraries: newItineraries };
    }

    case "CLEAR_DATA":
      return {
        ...state,
        log: null,
        trips: new Map(),
        activities: new Map(),
        itineraries: new Map(),
      };

    case "SET_LOADING":
      return { ...state, loading: action.loading };

    default:
      return state;
  }
}

const initialState: TravelState = {
  userSlugs: {},
  slugsLoaded: false,
  log: null,
  trips: new Map(),
  activities: new Map(),
  itineraries: new Map(),
  loading: true,
};

interface ContextType {
  state: TravelState;
  dispatch: React.Dispatch<TravelAction>;
  setCurrentLog: (logId: string) => void;
}

const TravelContext = createContext<ContextType | null>(null);

export function TravelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { user } = useAuth();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const logUnsubsRef = useRef<(() => void)[]>([]);
  const currentLogIdRef = useRef<string | null>(null);

  // Subscribe to user's travel slugs when authenticated
  useEffect(() => {
    let cancelled = false;
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch, () => cancelled);
    }
    return () => {
      cancelled = true;
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
      logUnsubsRef.current.forEach((unsub) => unsub());
      logUnsubsRef.current = [];
    };
  }, [user]);

  const setCurrentLog = useCallback(
    (logId: string) => {
      if (!user) return;
      if (currentLogIdRef.current === logId) return;

      logUnsubsRef.current.forEach((unsub) => unsub());
      logUnsubsRef.current = [];
      currentLogIdRef.current = logId;

      const cancelled = () => currentLogIdRef.current !== logId;
      subscribeToLog(logId, user.uid, dispatch, cancelled).then((unsubs) => {
        if (cancelled()) {
          unsubs.forEach((unsub) => unsub());
          return;
        }
        logUnsubsRef.current = unsubs;
      }).catch((err) => {
        console.error("[travel] subscribeToLog failed:", err);
        if (!cancelled()) {
          dispatch({ type: "SET_LOADING", loading: false });
        }
      });
    },
    [user]
  );

  return (
    <TravelContext.Provider value={{ state, dispatch, setCurrentLog }}>
      {children}
    </TravelContext.Provider>
  );
}

export function useTravelContext() {
  const context = useContext(TravelContext);
  if (!context) {
    throw new Error("useTravelContext must be used within TravelProvider");
  }
  return context;
}
