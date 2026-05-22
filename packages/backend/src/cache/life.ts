/**
 * Life backend cache decorator.
 */
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeEvent } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withLifeCache(inner: LifeBackend): LifeBackend {
  return {
    getOrCreateLog: (userId) => cachedRead<LifeLog>(`life:log:${userId}`, () => inner.getOrCreateLog(userId)),

    clearSampleSchedule: (id) => inner.clearSampleSchedule(id),
    updateReminderTimes: (id, t) => inner.updateReminderTimes(id, t),
    setRandomSamplingEnabled: (id, enabled) => inner.setRandomSamplingEnabled(id, enabled),
    addEvent: (id, s, e, u, o) => inner.addEvent(id, s, e, u, o),
    updateEvent: (id, u) => inner.updateEvent(id, u),
    deleteEvent: (id) => inner.deleteEvent(id),

    subscribeToEvents(logId, onEvents): Unsubscribe {
      const key = `life:events:${logId}`;
      const h = hydrateOne<LifeEvent[]>(key, onEvents);
      return inner.subscribeToEvents(
        logId,
        cached(key, (events) => {
          h.live();
          onEvents(events);
        }),
      );
    },
  };
}
