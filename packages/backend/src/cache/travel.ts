/**
 * Travel backend cache decorator.
 *
 * Reads and subscriptions are served from IndexedDB while offline; writes
 * pass through to the underlying backend (and will reject when offline).
 */
import type { TravelBackend } from "../interfaces/travel";
import type { TravelLog, Trip, Activity, Itinerary, DayEntry } from "../types/travel";
import type { Unsubscribe } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withTravelCache(inner: TravelBackend): TravelBackend {
  return {
    // Reads
    getOrCreateLog: (userId) => cachedRead(`travel:logId:${userId}`, () => inner.getOrCreateLog(userId)),

    // Writes — pass through; offline calls will reject naturally.
    addTrip: (logId, trip) => inner.addTrip(logId, trip),
    updateTrip: (id, u) => inner.updateTrip(id, u),
    deleteTrip: (id) => inner.deleteTrip(id),
    flagTrip: (id, f, c) => inner.flagTrip(id, f, c),
    addActivity: (logId, a) => inner.addActivity(logId, a),
    updateActivity: (id, u) => inner.updateActivity(id, u),
    deleteActivity: (id) => inner.deleteActivity(id),
    addItinerary: (logId, tripId, i) => inner.addItinerary(logId, tripId, i),
    updateItinerary: (id, u) => inner.updateItinerary(id, u),
    setItineraryDays: (id, days) => inner.setItineraryDays(id, days),
    deleteItinerary: (id) => inner.deleteItinerary(id),
    upsertDayEntry: (logId, tripId, date, fields) => inner.upsertDayEntry(logId, tripId, date, fields),
    deleteDayEntry: (id) => inner.deleteDayEntry(id),

    // Subscription — hydrate from cache, then wrap callbacks to auto-persist.
    subscribeToLog(logId, handlers): Unsubscribe {
      const logKey = `travel:log:${logId}`;
      const tripsKey = `travel:trips:${logId}`;
      const activitiesKey = `travel:activities:${logId}`;
      const itinerariesKey = `travel:itineraries:${logId}`;
      const dayEntriesKey = `travel:dayEntries:${logId}`;

      const logHydrate = hydrateOne<TravelLog>(logKey, handlers.onLog);
      const tripsHydrate = hydrateOne<Trip[]>(tripsKey, handlers.onTrips);
      const actsHydrate = hydrateOne<Activity[]>(activitiesKey, handlers.onActivities);
      const itinHydrate = hydrateOne<Itinerary[]>(itinerariesKey, handlers.onItineraries);
      const dayHydrate = hydrateOne<DayEntry[]>(dayEntriesKey, handlers.onDayEntries);

      const unsub = inner.subscribeToLog(logId, {
        onLog: cached(logKey, (log) => {
          logHydrate.live();
          handlers.onLog(log);
        }),
        onTrips: cached(tripsKey, (trips) => {
          tripsHydrate.live();
          handlers.onTrips(trips);
        }),
        onActivities: cached(activitiesKey, (activities) => {
          actsHydrate.live();
          handlers.onActivities(activities);
        }),
        onItineraries: cached(itinerariesKey, (itineraries) => {
          itinHydrate.live();
          handlers.onItineraries(itineraries);
        }),
        onDayEntries: cached(dayEntriesKey, (entries) => {
          dayHydrate.live();
          handlers.onDayEntries(entries);
        }),
        onDeleted: handlers.onDeleted,
      });

      return unsub;
    },
  };
}
