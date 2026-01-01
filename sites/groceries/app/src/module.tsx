/**
 * GroceriesModule - Embeddable groceries app component
 *
 * This module can be used standalone or embedded in another app.
 * It expects the parent to provide authentication via @kirkl/shared AuthProvider.
 */

import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { GroceriesProvider } from "./groceries-context";
import { GroceryList } from "./components/GroceryList";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

export function GroceriesRoutes() {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<GroceryList />} />
    </Routes>
  );
}

export function GroceriesModule() {
  return (
    <GroceriesProvider>
      <GroceriesRoutes />
    </GroceriesProvider>
  );
}

// Re-export provider for standalone use
export { GroceriesProvider, useGroceriesContext } from "./groceries-context";
