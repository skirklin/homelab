/**
 * PocketBase real-time subscriptions for the life tracker app.
 * Uses the LifeBackend interface for subscription management.
 */
import { useEffect } from "react";
import type { LifeEntry } from "@homelab/backend";
import { useLifeContext } from "./life-context";
import { useLifeBackend } from "@kirkl/shared";
import type { LogEntry } from "./types";

/** Convert backend LifeEntry to app LogEntry (Event). */
function toLogEntry(entry: LifeEntry): LogEntry {
  const data: Record<string, unknown> = { ...entry.data };
  if (entry.notes !== undefined) {
    data.notes = entry.notes;
  }
  return {
    id: entry.id,
    subjectId: entry.widgetId,
    timestamp: entry.timestamp,
    createdAt: entry.timestamp,
    createdBy: entry.createdBy,
    data,
  };
}

export function useEntriesSubscription(logId: string | null) {
  const { dispatch } = useLifeContext();
  const life = useLifeBackend();

  useEffect(() => {
    if (!logId) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }

    const unsub = life.subscribeToEntries(logId, (entries: LifeEntry[]) => {
      const logEntries = entries.map(toLogEntry);
      dispatch({ type: "SET_ENTRIES", entries: logEntries });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      unsub();
    };
  }, [logId, dispatch, life]);
}
