import { useEffect } from "react";
import { collection, query, onSnapshot, orderBy, limit } from "firebase/firestore";
import { getBackend } from "@kirkl/shared";
import { useLife } from "./life-context";
import { setCurrentLogId, getCurrentLogId } from "./firestore";
import type { LogEntry, LogEntryStore } from "./types";

function convertEntry(id: string, data: LogEntryStore): LogEntry {
  return {
    id,
    activityId: data.activityId,
    startTime: data.startTime.toDate(),
    endTime: data.endTime?.toDate() ?? null,
    duration: data.duration,
    notes: data.notes,
    createdBy: data.createdBy,
    createdAt: data.createdAt.toDate(),
  };
}

export function useEntriesSubscription(logId: string | null) {
  const { dispatch } = useLife();

  useEffect(() => {
    if (!logId) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }

    // Set current log ID for firestore operations
    setCurrentLogId(logId);

    const { db } = getBackend();
    const entriesRef = collection(db, "lifeLogs", logId, "entries");
    const q = query(entriesRef, orderBy("startTime", "desc"), limit(100));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LogEntry[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data() as LogEntryStore;
        entries.push(convertEntry(doc.id, data));
      });
      dispatch({ type: "SET_ENTRIES", entries });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      unsubscribe();
      if (getCurrentLogId() === logId) {
        setCurrentLogId(null);
      }
    };
  }, [logId, dispatch]);
}
