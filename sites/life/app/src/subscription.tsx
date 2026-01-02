import { useEffect } from "react";
import { collection, query, onSnapshot, orderBy, limit } from "firebase/firestore";
import { getBackend, eventFromStore, type EventStore } from "@kirkl/shared";
import { useLife } from "./life-context";
import { setCurrentLogId, getCurrentLogId } from "./firestore";
import type { LogEntry } from "./types";

export function useEntriesSubscription(logId: string | null) {
  const { dispatch } = useLife();

  useEffect(() => {
    if (!logId) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }

    setCurrentLogId(logId);

    const { db } = getBackend();
    const eventsRef = collection(db, "lifeLogs", logId, "events");
    const q = query(eventsRef, orderBy("timestamp", "desc"), limit(100));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LogEntry[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data() as EventStore;
        entries.push(eventFromStore(doc.id, data));
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
