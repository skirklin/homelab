import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useAuth } from "@kirkl/shared";
import { useTravelBackend, useUserBackend } from "@kirkl/shared";
import { tripFromBackend, activityFromBackend, itineraryFromBackend, logFromBackend } from "./adapters";
import type { Trip, TravelLog, Activity, Itinerary, TravelNote } from "./types";

export interface TravelState {
  userSlugs: Record<string, string>;
  slugsLoaded: boolean;
  log: TravelLog | null;
  trips: Map<string, Trip>;
  activities: Map<string, Activity>;
  itineraries: Map<string, Itinerary>;
  /** Per-user feedback notes for the whole log; filtered by subject in the UI. */
  notes: Map<string, TravelNote>;
  loading: boolean;
}

export type TravelAction =
  | { type: "SET_USER_SLUGS"; slugs: Record<string, string>; }
  | { type: "SET_LOG"; log: TravelLog | null }
  | { type: "SET_TRIPS"; trips: Trip[] }
  | { type: "SET_ACTIVITIES"; activities: Activity[] }
  | { type: "SET_ITINERARIES"; itineraries: Itinerary[] }
  | { type: "SET_NOTES"; notes: TravelNote[] }
  | { type: "CLEAR_DATA" }
  | { type: "SET_LOADING"; loading: boolean };

function reducer(state: TravelState, action: TravelAction): TravelState {
  switch (action.type) {
    case "SET_USER_SLUGS":
      return { ...state, userSlugs: action.slugs, slugsLoaded: true };

    case "SET_LOG":
      return { ...state, log: action.log };

    case "SET_TRIPS": {
      const newTrips = new Map<string, Trip>();
      for (const trip of action.trips) newTrips.set(trip.id, trip);
      return { ...state, trips: newTrips, loading: false };
    }

    case "SET_ACTIVITIES": {
      const newActivities = new Map<string, Activity>();
      for (const activity of action.activities) newActivities.set(activity.id, activity);
      return { ...state, activities: newActivities };
    }

    case "SET_ITINERARIES": {
      const newItineraries = new Map<string, Itinerary>();
      for (const itinerary of action.itineraries) newItineraries.set(itinerary.id, itinerary);
      return { ...state, itineraries: newItineraries };
    }

    case "SET_NOTES": {
      const m = new Map<string, TravelNote>();
      for (const n of action.notes) m.set(n.id, n);
      return { ...state, notes: m };
    }

    case "CLEAR_DATA":
      return {
        ...state,
        log: null,
        trips: new Map(),
        activities: new Map(),
        itineraries: new Map(),
        notes: new Map(),
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
  notes: new Map(),
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
  const travel = useTravelBackend();
  const userBackend = useUserBackend();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const logUnsubRef = useRef<(() => void) | null>(null);
  const currentLogIdRef = useRef<string | null>(null);

  // Subscribe to user's travel slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = userBackend.subscribeSlugs(user.uid, "travel", (slugs) => {
        dispatch({ type: "SET_USER_SLUGS", slugs });
      });
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
    };
  }, [user?.uid, userBackend]);

  const setCurrentLog = useCallback(
    (logId: string) => {
      if (!user) return;
      if (currentLogIdRef.current === logId) return;

      if (logUnsubRef.current) {
        logUnsubRef.current();
        logUnsubRef.current = null;
      }
      currentLogIdRef.current = logId;

      dispatch({ type: "CLEAR_DATA" });
      dispatch({ type: "SET_LOADING", loading: true });

      const unsub = travel.subscribeToLog(logId, {
        onLog: (log) => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_LOG", log: logFromBackend(log) });
        },
        onTrips: (trips) => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_TRIPS", trips: trips.map(tripFromBackend) });
        },
        onActivities: (activities) => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_ACTIVITIES", activities: activities.map(activityFromBackend) });
        },
        onItineraries: (itineraries) => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_ITINERARIES", itineraries: itineraries.map(itineraryFromBackend) });
        },
        // Notes ride the log-level mirror. The payload is already TravelNote[]
        // (no app-local adapter needed) and log-scoped, so the UI just filters
        // by (subjectType, subjectId).
        onNotes: (notes) => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_NOTES", notes });
        },
        onDeleted: () => {
          if (currentLogIdRef.current !== logId) return;
          dispatch({ type: "SET_LOG", log: null });
        },
      });

      logUnsubRef.current = unsub;
    },
    [user?.uid, travel]
  );

  const contextValue = useMemo(
    () => ({ state, dispatch, setCurrentLog }),
    [state, setCurrentLog]
  );

  return (
    <TravelContext.Provider value={contextValue}>
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
