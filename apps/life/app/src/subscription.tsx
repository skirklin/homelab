/**
 * PocketBase real-time subscriptions for the life tracker app.
 * Uses the LifeBackend interface for subscription management.
 */
import { useEffect } from "react";
import type { LifeEvent } from "@homelab/backend";
import { useLifeContext } from "./life-context";
import { useLifeBackend } from "@kirkl/shared";

export function useEntriesSubscription(logId: string | null) {
  const { dispatch } = useLifeContext();
  const life = useLifeBackend();

  useEffect(() => {
    if (!logId) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }

    const unsub = life.subscribeToEvents(logId, (events: LifeEvent[]) => {
      dispatch({ type: "SET_ENTRIES", entries: events });
      dispatch({ type: "SET_LOADING", loading: false });
    });

    return () => {
      unsub();
    };
  }, [logId, dispatch, life]);
}
