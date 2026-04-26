/**
 * Life backend cache decorator.
 */
import type { LifeBackend } from "../interfaces/life";
import type { LifeLog, LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withLifeCache(inner: LifeBackend): LifeBackend {
  return {
    getOrCreateLog: (userId) => cachedRead<LifeLog>(`life:log:${userId}`, () => inner.getOrCreateLog(userId)),

    updateManifest: (id, m) => inner.updateManifest(id, m),
    clearSampleSchedule: (id) => inner.clearSampleSchedule(id),
    addEntry: (id, w, d, u, o) => inner.addEntry(id, w, d, u, o),
    updateEntry: (id, u) => inner.updateEntry(id, u),
    deleteEntry: (id) => inner.deleteEntry(id),
    addSampleResponse: (id, r, u) => inner.addSampleResponse(id, r, u),

    subscribeToEntries(logId, onEntries): Unsubscribe {
      const key = `life:entries:${logId}`;
      const h = hydrateOne<LifeEntry[]>(key, onEntries);
      return inner.subscribeToEntries(
        logId,
        cached(key, (entries) => {
          h.live();
          onEntries(entries);
        }),
      );
    },
  };
}
