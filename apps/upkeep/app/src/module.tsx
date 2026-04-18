/**
 * Upkeep module for embedding in the home app.
 * Provides routes that can be mounted at /upkeep/*
 */
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { BackendProvider } from "@kirkl/shared";
import { UpkeepProvider } from "./upkeep-context";
import { TaskBoard } from "./components/TaskBoard";
import { TaskOutliner } from "./components/TaskOutliner";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
// Storage is imported to trigger legacy key migration on startup
import "./storage";

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

/** Tasks module — outliner view on the same data as upkeep. Mounted at /tasks/* */
export function TasksRoutes({ embedded = false }: UpkeepRoutesProps) {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/:slug" element={<TaskOutliner embedded={embedded} />} />
    </Routes>
  );
}

export function UpkeepModule() {
  return (
    <BackendProvider>
      <UpkeepProvider>
        <UpkeepRoutes />
      </UpkeepProvider>
    </BackendProvider>
  );
}

export { UpkeepProvider, useUpkeepContext } from "./upkeep-context";
export { BackendProvider as UpkeepBackendProvider } from "@kirkl/shared";
export { isNotificationSupported, requestNotificationPermission, getFcmToken } from "./messaging";
