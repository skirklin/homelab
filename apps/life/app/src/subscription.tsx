/**
 * PocketBase real-time subscriptions for the life tracker app.
 * Replaces Firestore onSnapshot listeners with PocketBase SSE subscriptions.
 */
import { useEffect } from "react";
import { getBackend, eventFromStore, type EventStore } from "@kirkl/shared";
import { useLife } from "./life-context";
import { setCurrentLogId, getCurrentLogId } from "./pocketbase";
import type { LogEntry } from "./types";

export function useEntriesSubscription(logId: string | null) {
  const { dispatch } = useLife();

  useEffect(() => {
    if (!logId) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }

    setCurrentLogId(logId);

    const pb = getBackend();
    let cancelled = false;

    // Load initial events — disable auto-cancel to prevent React re-render races
    pb.collection("life_events")
      .getFullList({
        filter: `log = "${logId}"`,
        sort: "-timestamp",
        $autoCancel: false,
      })
      .then((records) => {
        if (cancelled) return;
        const entries: LogEntry[] = records.map((r) =>
          eventFromStore(r.id, r as unknown as EventStore & { created: string })
        );
        dispatch({ type: "SET_ENTRIES", entries });
        dispatch({ type: "SET_LOADING", loading: false });
      })
      .catch((err) => {
        console.error("Failed to load life events:", err);
        dispatch({ type: "SET_LOADING", loading: false });
      });

    // Subscribe to real-time changes
    pb.collection("life_events").subscribe("*", (e) => {
      if (e.record.log !== logId) return;
      if (e.action === "delete") {
        dispatch({ type: "REMOVE_ENTRY", entryId: e.record.id });
      } else {
        const entry = eventFromStore(
          e.record.id,
          e.record as unknown as EventStore & { created: string }
        );
        dispatch({ type: "SET_ENTRY", entry });
      }
    });

    return () => {
      cancelled = true;
      pb.collection("life_events").unsubscribe("*");
      if (getCurrentLogId() === logId) {
        setCurrentLogId(null);
      }
    };
  }, [logId, dispatch]);
}
