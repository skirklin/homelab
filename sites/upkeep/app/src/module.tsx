/**
 * Upkeep module for embedding in the home app.
 * Provides routes that can be mounted at /upkeep/*
 */
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { UpkeepProvider } from "./upkeep-context";
import { TaskBoard } from "./components/TaskBoard";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

interface UpkeepRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
}

export function UpkeepRoutes({ embedded = false }: UpkeepRoutesProps) {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<TaskBoard embedded={embedded} />} />
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

export { UpkeepProvider, useUpkeepContext } from "./upkeep-context";
export { isNotificationSupported, requestNotificationPermission, getFcmToken } from "./messaging";
