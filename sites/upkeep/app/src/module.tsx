/**
 * Upkeep module for embedding in the home app.
 * Provides routes that can be mounted at /upkeep/*
 */
import { useEffect, useRef } from "react";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { UpkeepProvider, useUpkeepContext } from "./upkeep-context";
import { subscribeToUserSlugs, subscribeToList } from "./subscription";
import { TaskBoard } from "./components/TaskBoard";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

function UpkeepRoutes() {
  const { user } = useAuth();
  const { state, dispatch } = useUpkeepContext();
  const slugsUnsubRef = useRef<(() => void) | null>(null);
  const listUnsubsRef = useRef<(() => void)[] | null>(null);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch);
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
    };
  }, [user, dispatch]);

  if (!user) return null;

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<TaskBoard />} />
    </Routes>
  );
}

export function UpkeepModule() {
  return (
    <UpkeepProvider>
      <UpkeepRoutes />
    </UpkeepProvider>
  );
}
